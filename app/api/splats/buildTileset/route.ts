import { NextRequest, NextResponse } from "next/server";

import { requireArtifactAccess, requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { buildSplatTilesetQueue } from "@/lib/queue/queues";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { buildTilesetPayloadSchema } from "@/lib/validation/schemas";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = buildTilesetPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid tileset payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const presetName = parseSplatTilesetPresetName(parsed.data.presetName);
    const access = await requireArtifactAccess(parsed.data.artifactId, "editor");
    await enforceRateLimit({
      bucket: "run:create:tileset",
      identifier: access.user.id,
      limit: env.RUN_CREATE_LIMIT,
      windowSec: env.RUN_CREATE_WINDOW_SEC,
      message: "Tileset build rate limit exceeded"
    });

    const artifact = await prisma.artifact.findUnique({
      where: { id: parsed.data.artifactId },
      select: {
        id: true,
        projectId: true,
        kind: true
      }
    });

    if (!artifact) {
      return NextResponse.json({ error: "Source artifact not found" }, { status: 404 });
    }
    if (artifact.kind !== "point_ply" && artifact.kind !== "splat_ksplat") {
      return NextResponse.json({ error: "Tileset build is supported only for splat PLY artifacts." }, { status: 400 });
    }

    const safePreset = presetName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const jobId = `splat-tileset-${artifact.id}-${safePreset}-${Date.now()}`;

    const job = await buildSplatTilesetQueue.add(
      "build",
      {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        presetName
      },
      {
        jobId
      }
    );

    await logAuditEventFromRequest(req, {
      action: "run_start",
      resourceType: "splat_tileset_job",
      resourceId: String(job.id),
      projectId: artifact.projectId,
      userId: access.user.id
    });

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      queue: "buildSplatTilesetFromPly",
      presetName
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to enqueue tileset build job");
  }
}

export async function GET(req: NextRequest) {
  try {
    const jobId = req.nextUrl.searchParams.get("jobId")?.trim() ?? "";
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }

    const job = await buildSplatTilesetQueue.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const payload = (job.data ?? {}) as {
      projectId?: string;
    };
    if (typeof payload.projectId !== "string" || payload.projectId.length === 0) {
      return NextResponse.json({ error: "Job payload missing project context" }, { status: 400 });
    }
    await requireProjectAccess(payload.projectId, "viewer");

    const [state, progress, returnValue, failedReason] = await Promise.all([
      job.getState(),
      Promise.resolve(job.progress),
      Promise.resolve(job.returnvalue),
      Promise.resolve(job.failedReason ?? null)
    ]);

    return NextResponse.json({
      jobId: job.id,
      state,
      progress,
      returnValue,
      failedReason
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read tileset build job");
  }
}
