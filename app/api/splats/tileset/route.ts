import { NextRequest, NextResponse } from "next/server";

import { requireArtifactAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";
import { findLatestTilesetArtifactForSource } from "@/lib/splats/tileset-artifacts";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";
import { artifactAccessQuerySchema } from "@/lib/validation/schemas";

export async function GET(req: NextRequest) {
  try {
    const parsed = artifactAccessQuerySchema.safeParse({
      artifactId: req.nextUrl.searchParams.get("artifactId")
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "artifactId is required", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const presetName = parseSplatTilesetPresetName(req.nextUrl.searchParams.get("presetName"));
    const access = await requireArtifactAccess(parsed.data.artifactId, "viewer");
    await enforceRateLimit({
      bucket: "signed-url:splat-tileset",
      identifier: access.user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Signed URL rate limit exceeded"
    });

    const sourceArtifact = await prisma.artifact.findUnique({
      where: { id: parsed.data.artifactId },
      select: {
        id: true,
        projectId: true
      }
    });

    if (!sourceArtifact) {
      return NextResponse.json({ error: "Source artifact not found" }, { status: 404 });
    }

    const tilesetArtifact = await findLatestTilesetArtifactForSource({
      projectId: sourceArtifact.projectId,
      sourceArtifactId: sourceArtifact.id,
      presetName
    });

    if (!tilesetArtifact) {
      return NextResponse.json({
        exists: false,
        artifactId: sourceArtifact.id,
        presetName
      });
    }

    const tilesetUrl = await safeGetSignedDownloadUrl(tilesetArtifact.storageKey, env.SIGNED_URL_TTL_SEC);
    await logAuditEventFromRequest(req, {
      action: "artifact_download",
      resourceType: "artifact",
      resourceId: tilesetArtifact.id,
      projectId: sourceArtifact.projectId,
      userId: access.user.id
    });

    return NextResponse.json({
      exists: Boolean(tilesetUrl),
      artifactId: sourceArtifact.id,
      presetName,
      tilesetArtifactId: tilesetArtifact.id,
      tilesetStorageKey: tilesetArtifact.storageKey,
      tilesetUrl
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to load splat tileset");
  }
}
