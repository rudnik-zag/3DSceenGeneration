import { NextRequest, NextResponse } from "next/server";

import { Artifact } from "@prisma/client";

import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";

interface WorldManifestMeshEntry {
  id: string;
  artifactId: string;
  nodeId: string;
  kind: string;
  url: string;
}

interface WorldManifestSplatEntry {
  id: string;
  artifactId: string;
  nodeId: string;
  kind: string;
  sourceUrl: string | null;
  tilesetUrl: string | null;
  presetName: string | null;
  transform: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
}

function parseTilesetMeta(artifact: Artifact) {
  if (!artifact.meta || typeof artifact.meta !== "object" || Array.isArray(artifact.meta)) return null;
  const meta = artifact.meta as Record<string, unknown>;
  if (meta.type !== "splat_tileset") return null;
  return {
    sourceArtifactId: typeof meta.sourceArtifactId === "string" ? meta.sourceArtifactId : null,
    presetName: typeof meta.presetName === "string" ? meta.presetName : null
  };
}

function uniqueById<T extends { id: string }>(entries: T[]) {
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const item of entries) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    ordered.push(item);
  }
  return ordered;
}

export async function GET(req: NextRequest) {
  const artifactId = req.nextUrl.searchParams.get("artifactId")?.trim() ?? "";
  if (!artifactId) {
    return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
  }

  const selectedArtifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    include: {
      project: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  if (!selectedArtifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const relatedArtifacts = await prisma.artifact.findMany({
    where: {
      projectId: selectedArtifact.projectId,
      ...(selectedArtifact.runId
        ? { runId: selectedArtifact.runId }
        : { id: selectedArtifact.id })
    },
    orderBy: { createdAt: "desc" },
    take: 220
  });
  const artifacts = uniqueById([selectedArtifact, ...relatedArtifacts]);

  const tilesetCandidates = await prisma.artifact.findMany({
    where: {
      projectId: selectedArtifact.projectId,
      kind: "json"
    },
    orderBy: { createdAt: "desc" },
    take: 400
  });
  const latestTilesetBySourceArtifact = new Map<string, Artifact>();
  for (const artifact of tilesetCandidates) {
    const meta = parseTilesetMeta(artifact);
    if (!meta?.sourceArtifactId) continue;
    if (!latestTilesetBySourceArtifact.has(meta.sourceArtifactId)) {
      latestTilesetBySourceArtifact.set(meta.sourceArtifactId, artifact);
    }
  }

  const meshArtifacts = artifacts.filter((artifact) => artifact.kind === "mesh_glb");
  const splatArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "point_ply" || artifact.kind === "splat_ksplat"
  );

  const meshes: WorldManifestMeshEntry[] = [];
  for (const meshArtifact of meshArtifacts) {
    const url = await safeGetSignedDownloadUrl(meshArtifact.storageKey);
    if (!url) continue;
    meshes.push({
      id: `mesh-${meshArtifact.id}`,
      artifactId: meshArtifact.id,
      nodeId: meshArtifact.nodeId,
      kind: meshArtifact.kind,
      url
    });
  }

  const splats: WorldManifestSplatEntry[] = [];
  for (const splatArtifact of splatArtifacts) {
    const sourceUrl = await safeGetSignedDownloadUrl(splatArtifact.storageKey);
    const tilesetArtifact = latestTilesetBySourceArtifact.get(splatArtifact.id) ?? null;
    const tilesetUrl = tilesetArtifact
      ? await safeGetSignedDownloadUrl(tilesetArtifact.storageKey)
      : null;
    const tilesetMeta = tilesetArtifact ? parseTilesetMeta(tilesetArtifact) : null;
    splats.push({
      id: `splat-${splatArtifact.id}`,
      artifactId: splatArtifact.id,
      nodeId: splatArtifact.nodeId,
      kind: splatArtifact.kind,
      sourceUrl,
      tilesetUrl,
      presetName: tilesetMeta?.presetName ?? null,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      }
    });
  }

  const selectedSplat = splats.find((entry) => entry.artifactId === selectedArtifact.id) ?? null;
  const canBuildTileset =
    (selectedArtifact.kind === "point_ply" || selectedArtifact.kind === "splat_ksplat") &&
    !selectedSplat?.tilesetUrl;

  return NextResponse.json({
    artifactId: selectedArtifact.id,
    projectId: selectedArtifact.projectId,
    camera: {
      position: [4, 3, 4],
      target: [0, 0, 0],
      fov: 50
    },
    meshes,
    splats,
    build: {
      canBuildTileset,
      defaultPresetName: "Default"
    }
  });
}
