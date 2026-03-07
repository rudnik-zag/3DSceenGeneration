import { Artifact } from "@prisma/client";

import { prisma } from "@/lib/db";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";
import { SplatTilesetPresetName } from "@/lib/splats/types";

interface TilesetArtifactMeta {
  type?: string;
  sourceArtifactId?: string;
  presetName?: string;
  tilesetStorageKey?: string;
}

function readTilesetMeta(artifact: Artifact) {
  if (!artifact.meta || typeof artifact.meta !== "object" || Array.isArray(artifact.meta)) {
    return null;
  }
  return artifact.meta as TilesetArtifactMeta;
}

export function isTilesetArtifactForSource(
  artifact: Artifact,
  sourceArtifactId: string,
  presetName?: SplatTilesetPresetName
) {
  const meta = readTilesetMeta(artifact);
  if (!meta) return false;
  if (meta.type !== "splat_tileset") return false;
  if (meta.sourceArtifactId !== sourceArtifactId) return false;
  if (presetName && parseSplatTilesetPresetName(meta.presetName) !== presetName) return false;
  return true;
}

export async function findLatestTilesetArtifactForSource(input: {
  projectId: string;
  sourceArtifactId: string;
  presetName?: SplatTilesetPresetName;
}) {
  const candidates = await prisma.artifact.findMany({
    where: {
      projectId: input.projectId,
      kind: "json"
    },
    orderBy: { createdAt: "desc" },
    take: 400
  });

  return (
    candidates.find((artifact) =>
      isTilesetArtifactForSource(artifact, input.sourceArtifactId, input.presetName)
    ) ?? null
  );
}

