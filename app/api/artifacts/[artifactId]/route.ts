import { NextRequest, NextResponse } from "next/server";

import { requireArtifactAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { deleteStorageObject, safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const { artifactId } = await params;
    const access = await requireArtifactAccess(artifactId, "viewer");
    await enforceRateLimit({
      bucket: "signed-url:artifact",
      identifier: access.user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Signed URL rate limit exceeded"
    });

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

    const url = await safeGetSignedDownloadUrl(artifact.storageKey, env.SIGNED_URL_TTL_SEC);
    const previewUrl = artifact.previewStorageKey
      ? await safeGetSignedDownloadUrl(artifact.previewStorageKey, env.SIGNED_URL_TTL_SEC)
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

    await logAuditEventFromRequest(req, {
      action: "artifact_download",
      resourceType: "artifact",
      resourceId: artifact.id,
      projectId: artifact.projectId,
      userId: access.user.id
    });

    return NextResponse.json({ artifact, url, previewUrl });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read artifact");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  try {
    const { artifactId } = await params;
    const access = await requireArtifactAccess(artifactId, "editor");

    const artifact = await prisma.artifact.findFirst({
      where: {
        id: artifactId
      },
      select: {
        id: true,
        projectId: true,
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

    await logAuditEventFromRequest(req, {
      action: "artifact_delete",
      resourceType: "artifact",
      resourceId: artifact.id,
      projectId: artifact.projectId,
      userId: access.user.id
    });

    return NextResponse.json({
      ok: true,
      deletedArtifactId: artifactId
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to delete artifact");
  }
}
