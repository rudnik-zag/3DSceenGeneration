import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId }
  });

  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const exists = await storageObjectExists(artifact.storageKey);
  if (!exists) {
    return NextResponse.json(
      {
        error:
          "Artifact file is missing in object storage. Re-run workflow to regenerate this artifact.",
        storageKey: artifact.storageKey
      },
      { status: 404 }
    );
  }

  const url = await safeGetSignedDownloadUrl(artifact.storageKey);
  const previewUrl = artifact.previewStorageKey
    ? await safeGetSignedDownloadUrl(artifact.previewStorageKey)
    : null;

  if (!url) {
    return NextResponse.json(
      {
        error:
          "Artifact storage is unavailable. Start MinIO (or configure S3 endpoint) and retry."
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ artifact, url, previewUrl });
}
