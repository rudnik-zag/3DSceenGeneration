import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { requireRunAccess } from "@/lib/auth/access";
import { finalizeRunUsage } from "@/lib/billing/usage";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { recordRunEvent } from "@/lib/execution/telemetry";
import { runWorkflowQueue } from "@/lib/queue/queues";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";
import { runActionSchema } from "@/lib/validation/schemas";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const access = await requireRunAccess(runId, "viewer");
    await enforceRateLimit({
      bucket: "signed-url:run",
      identifier: access.user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Signed URL rate limit exceeded"
    });

    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: {
        artifacts: {
          orderBy: { createdAt: "desc" }
        }
      }
    });

    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    const [steps, events] = await Promise.all([
      prisma.$queryRaw(
        Prisma.sql`
          SELECT *
          FROM "RunStep"
          WHERE "runId" = ${runId}
          ORDER BY "sequence" ASC, "createdAt" ASC
        `
      ),
      prisma.$queryRaw(
        Prisma.sql`
          SELECT *
          FROM "RunEvent"
          WHERE "runId" = ${runId}
          ORDER BY "createdAt" ASC
          LIMIT 1000
        `
      )
    ]);

    const artifacts = await Promise.all(
      run.artifacts.map(async (artifact) => {
        const meta =
          artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)
            ? (artifact.meta as Record<string, unknown>)
            : {};
        const outputKey = typeof meta.outputKey === "string" ? meta.outputKey : "default";
        const hidden = Boolean(meta.hidden);
        const url = await safeGetSignedDownloadUrl(artifact.storageKey, env.SIGNED_URL_TTL_SEC);
        const previewUrl = artifact.previewStorageKey
          ? await safeGetSignedDownloadUrl(artifact.previewStorageKey, env.SIGNED_URL_TTL_SEC)
          : null;
        return {
          ...artifact,
          outputKey,
          hidden,
          url,
          previewUrl
        };
      })
    );

    return NextResponse.json({
      run: {
        ...run,
        artifacts,
        steps,
        events
      }
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read run");
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const access = await requireRunAccess(runId, "editor");
    const body = await req.json().catch(() => ({}));
    const parsed = runActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    const current = await prisma.run.findUnique({ where: { id: runId } });
    if (!current) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    if (["success", "error", "canceled"].includes(current.status)) {
      return NextResponse.json({ run: current });
    }

    const run = await prisma.run.update({
      where: { id: runId },
      data: {
        status: "canceled",
        finishedAt: new Date(),
        logs: `${current.logs}\n[${new Date().toISOString()}] Cancel requested`
      }
    });
    const queuedJob = await runWorkflowQueue.getJob(runId);
    if (queuedJob) {
      try {
        await queuedJob.remove();
      } catch {
        // Job may already be active or completed.
      }
    }
    await finalizeRunUsage({
      runId,
      status: "canceled"
    });

    await recordRunEvent({
      runId: run.id,
      projectId: run.projectId,
      graphId: run.graphId,
      userId: access.user.id,
      eventType: "run_cancel_requested",
      status: "canceled",
      message: "Run canceled from API"
    });

    await logAuditEventFromRequest(req, {
      action: "run_cancel",
      resourceType: "run",
      resourceId: run.id,
      projectId: run.projectId,
      userId: access.user.id
    });

    return NextResponse.json({ run });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to update run");
  }
}
