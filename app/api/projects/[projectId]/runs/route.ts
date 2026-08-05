import { NextRequest, NextResponse } from "next/server";

import { requireProjectAccess } from "@/lib/auth/access";
import { createRunWithTokenReservation, finalizeRunUsage } from "@/lib/billing/usage";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordRunEvent } from "@/lib/execution/telemetry";
import { runWorkflowQueue } from "@/lib/queue/queues";
import { reserveNextRunNumber } from "@/lib/runs/numbering";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonRequest } from "@/lib/security/request";
import { runCreatePayloadSchema } from "@/lib/validation/schemas";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    await requireProjectAccess(projectId, "viewer");
    const requestedLimit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
    const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50));
    const cursor = req.nextUrl.searchParams.get("cursor")?.trim() || null;
    const rows = await prisma.run.findMany({
      where: { projectId },
      orderBy: [{ runNumber: "desc" }, { createdAt: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        graph: {
          select: {
            id: true,
            name: true,
            version: true
          }
        },
        artifacts: {
          orderBy: { createdAt: "desc" }
        }
      }
    });
    const hasMore = rows.length > limit;
    const runs = hasMore ? rows.slice(0, limit) : rows;

    return NextResponse.json({ runs, nextCursor: hasMore ? runs.at(-1)?.id ?? null : null });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to list runs");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const access = await requireProjectAccess(projectId, "editor");
    await enforceRateLimit({
      bucket: "run:create",
      identifier: access.user.id,
      limit: env.RUN_CREATE_LIMIT,
      windowSec: env.RUN_CREATE_WINDOW_SEC,
      message: "Run creation rate limit exceeded"
    });

    const body = await readJsonRequest(req, 64 * 1024);
    const parsed = runCreatePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid run payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    let graphId = parsed.data.graphId;
    const startNodeId = parsed.data.startNodeId;

    if (!graphId) {
      const latestGraph = await prisma.graph.findFirst({
        where: { projectId },
        orderBy: { version: "desc" },
        select: { id: true }
      });
      graphId = latestGraph?.id;
    }

    if (!graphId) {
      return NextResponse.json({ error: "No graph found for project" }, { status: 400 });
    }
    const graph = await prisma.graph.findFirst({
      where: {
        id: graphId,
        projectId
      },
      select: {
        id: true,
        graphJson: true
      }
    });
    if (!graph) {
      return NextResponse.json({ error: "Graph not found for this project" }, { status: 404 });
    }

    const initialLog = `[${new Date().toISOString()}] Run queued`;
    const reservation = env.BILLING_ENFORCEMENT_ENABLED
      ? await createRunWithTokenReservation({
          userId: access.user.id,
          projectId,
          graphId: graph.id,
          graphJson: graph.graphJson,
          startNodeId,
          logs: initialLog
        })
      : null;
    const run =
      reservation?.run ??
      (await prisma.$transaction(async (tx) => {
        const runNumber = await reserveNextRunNumber(tx, projectId);
        return tx.run.create({
          data: {
            projectId,
            graphId: graph.id,
            runNumber,
            createdBy: access.user.id,
            status: "queued",
            logs: initialLog,
            progress: 0
          }
        });
      }));
    const queueOptions: { jobId: string; priority?: number } = {
      jobId: run.id
    };
    if (typeof reservation?.queuePriority === "number") {
      queueOptions.priority = reservation.queuePriority;
    }

    try {
      await runWorkflowQueue.add(
        "run",
        {
          projectId,
          graphId,
          runId: run.id,
          startNodeId
        },
        {
          ...queueOptions
        }
      );
    } catch (queueError) {
      const message = queueError instanceof Error ? queueError.message : "Queue unavailable";
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: "error",
          finishedAt: new Date(),
          logs: `${run.logs}\n[${new Date().toISOString()}] Queue failed: ${message}`
        }
      });
      if (reservation) {
        await finalizeRunUsage({ runId: run.id, status: "error" });
      }
      throw queueError;
    }

    await recordRunEvent({
      runId: run.id,
      projectId,
      graphId: graph.id,
      userId: access.user.id,
      eventType: "run_queued",
      status: "queued",
      message: "Run queued from project endpoint",
      metadata: {
        startNodeId: startNodeId ?? null,
        forceNodeIds: [] as string[]
      }
    });

    await logAuditEventFromRequest(req, {
      action: "run_start",
      resourceType: "run",
      resourceId: run.id,
      projectId,
      userId: access.user.id
    });

    return NextResponse.json(
      {
        run,
        billing: reservation
          ? {
              estimatedTokenCost: reservation.estimate.estimatedTokenCost,
              featureKey: reservation.estimate.featureKey,
              availableTokensAfterReserve: reservation.availableTokensAfterReserve,
              usageEventId: reservation.usageEventId
            }
          : null
      },
      { status: 201 }
    );
  } catch (error) {
    return toApiErrorResponse(error, "Failed to create run");
  }
}
