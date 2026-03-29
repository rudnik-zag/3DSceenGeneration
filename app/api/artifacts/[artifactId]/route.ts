import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";
import { deleteStorageObject, safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";

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

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;
  const user = await getOrCreateDefaultUser();

  const artifact = await prisma.artifact.findFirst({
    where: {
      id: artifactId,
      project: {
        userId: user.id
      }
    },
    select: {
      id: true,
      storageKey: true,
      previewStorageKey: true,
      meta: true
    }
  });

  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const storageKeys = new Set<string>();
  if (typeof artifact.storageKey === "string" && artifact.storageKey.length > 0) {
    storageKeys.add(artifact.storageKey);
  }
  if (typeof artifact.previewStorageKey === "string" && artifact.previewStorageKey.length > 0) {
    storageKeys.add(artifact.previewStorageKey);
  }
  if (artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)) {
    const meta = artifact.meta as Record<string, unknown>;
    if (Array.isArray(meta.meshObjectStorageKeys)) {
      for (const value of meta.meshObjectStorageKeys) {
        if (typeof value === "string" && value.length > 0) {
          storageKeys.add(value);
        }
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.cacheEntry.deleteMany({ where: { artifactId } });
    await tx.artifact.delete({ where: { id: artifactId } });
  });

  for (const key of storageKeys) {
    const metaContainsStorageKey = {
      path: ["meshObjectStorageKeys"],
      array_contains: [key]
    } as Record<string, unknown>;
    const [artifactRefs, uploadRefs] = await Promise.all([
      prisma.artifact.count({
        where: {
          OR: [
            { storageKey: key },
            { previewStorageKey: key },
            { meta: metaContainsStorageKey as never }
          ]
        }
      }),
      prisma.uploadAsset.count({
        where: { storageKey: key }
      })
    ]);
    if (artifactRefs > 0 || uploadRefs > 0) {
      continue;
    }
    await deleteStorageObject(key);
  }

  return NextResponse.json({
    ok: true,
    deletedArtifactId: artifactId
  });
}
