import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { buildSplatTilesetQueue } from "@/lib/queue/queues";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const artifactId = typeof body.artifactId === "string" ? body.artifactId.trim() : "";
    const presetName = parseSplatTilesetPresetName(body.presetName);

    if (!artifactId) {
      return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
    }

    const artifact = await prisma.artifact.findUnique({
      where: { id: artifactId },
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

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      queue: "buildSplatTilesetFromPly",
      presetName
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue tileset build job.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = await buildSplatTilesetQueue.getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

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
}
