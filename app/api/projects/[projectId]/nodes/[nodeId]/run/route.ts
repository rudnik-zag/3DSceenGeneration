import { NextRequest, NextResponse } from "next/server";

import { requireProjectAccess } from "@/lib/auth/access";
import { createRunWithTokenReservation } from "@/lib/billing/usage";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordRunEvent } from "@/lib/execution/telemetry";
import { runWorkflowQueue } from "@/lib/queue/queues";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { nodeRunPayloadSchema } from "@/lib/validation/schemas";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; nodeId: string }> }
) {
  try {
    const { projectId, nodeId } = await params;
    const access = await requireProjectAccess(projectId, "editor");
    await enforceRateLimit({
      bucket: "run:create:node",
      identifier: access.user.id,
      limit: env.RUN_CREATE_LIMIT,
      windowSec: env.RUN_CREATE_WINDOW_SEC,
      message: "Run creation rate limit exceeded"
    });

    const body = await req.json().catch(() => ({}));
    const parsed = nodeRunPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid node run payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const forceNodeCacheBypass = parsed.data.forceNodeCacheBypass !== false;
    let graphId = parsed.data.graphId;
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

    const initialLog = `[${new Date().toISOString()}] Node run queued (${nodeId}) forceCacheBypass=${forceNodeCacheBypass}`;
    const reservation = env.BILLING_ENFORCEMENT_ENABLED
      ? await createRunWithTokenReservation({
          userId: access.user.id,
          projectId,
          graphId: graph.id,
          graphJson: graph.graphJson,
          startNodeId: nodeId,
          logs: initialLog
        })
      : null;
    const run =
      reservation?.run ??
      (await prisma.run.create({
        data: {
          projectId,
          graphId: graph.id,
          createdBy: access.user.id,
          status: "queued",
          logs: initialLog,
          progress: 0
        }
      }));
    const queueOptions: { jobId: string; priority?: number } = {
      jobId: run.id
    };
    if (typeof reservation?.queuePriority === "number") {
      queueOptions.priority = reservation.queuePriority;
    }

    await runWorkflowQueue.add(
      "run",
      {
        projectId,
        graphId: graph.id,
        runId: run.id,
        startNodeId: nodeId,
        forceNodeIds: forceNodeCacheBypass ? [nodeId] : []
      },
      {
        ...queueOptions
      }
    );

    await recordRunEvent({
      runId: run.id,
      projectId: run.projectId,
      graphId: graph.id,
      userId: access.user.id,
      eventType: "run_queued",
      status: "queued",
      nodeId,
      message: "Node-scoped run queued",
      metadata: {
        startNodeId: nodeId,
        forceNodeIds: forceNodeCacheBypass ? [nodeId] : []
      }
    });

    await logAuditEventFromRequest(req, {
      action: "run_start",
      resourceType: "run",
      resourceId: run.id,
      projectId: run.projectId,
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
    return toApiErrorResponse(error, "Failed to queue node run");
  }
}
