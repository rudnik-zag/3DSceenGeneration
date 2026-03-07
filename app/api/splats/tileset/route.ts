import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";
import { findLatestTilesetArtifactForSource } from "@/lib/splats/tileset-artifacts";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";

export async function GET(req: NextRequest) {
  const artifactId = req.nextUrl.searchParams.get("artifactId")?.trim() ?? "";
  const presetName = parseSplatTilesetPresetName(req.nextUrl.searchParams.get("presetName"));

  if (!artifactId) {
    return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
  }

  const sourceArtifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
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

  const tilesetUrl = await safeGetSignedDownloadUrl(tilesetArtifact.storageKey);

  return NextResponse.json({
    exists: Boolean(tilesetUrl),
    artifactId: sourceArtifact.id,
    presetName,
    tilesetArtifactId: tilesetArtifact.id,
    tilesetStorageKey: tilesetArtifact.storageKey,
    tilesetUrl
  });
}

