import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
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

  const artifacts = await Promise.all(
    run.artifacts.map(async (artifact) => {
      const meta =
        artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)
          ? (artifact.meta as Record<string, unknown>)
          : {};
      const outputKey = typeof meta.outputKey === "string" ? meta.outputKey : "default";
      const hidden = Boolean(meta.hidden);
      const url = await safeGetSignedDownloadUrl(artifact.storageKey);
      const previewUrl = artifact.previewStorageKey
        ? await safeGetSignedDownloadUrl(artifact.previewStorageKey)
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
      artifacts
    }
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  const current = await prisma.run.findUnique({ where: { id: runId } });
  if (!current) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await prisma.run.update({
    where: { id: runId },
    data: {
      status: "canceled",
      finishedAt: new Date(),
      logs: `${current.logs}\n[${new Date().toISOString()}] Cancel requested`
    }
  });

  return NextResponse.json({ run });
}
