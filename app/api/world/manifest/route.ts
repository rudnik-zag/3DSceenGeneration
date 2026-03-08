import { NextRequest, NextResponse } from "next/server";

import { Artifact } from "@prisma/client";

import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";

type BundleMode = "same_node" | "project_fallback";

interface WorldManifestMeshEntry {
  id: string;
  artifactId: string;
  runId: string | null;
  nodeId: string;
  kind: string;
  url: string;
}

interface WorldManifestSplatEntry {
  id: string;
  artifactId: string;
  runId: string | null;
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

interface ArtifactMetaLike {
  meshObjectStorageKeys?: unknown;
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

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!value || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function normalizeUrlForDedup(url: string) {
  try {
    const parsed = new URL(url);
    const key = parsed.searchParams.get("key");
    if (parsed.pathname === "/api/storage/object" && key) {
      return `${parsed.origin}${parsed.pathname}?key=${key}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function toAbsoluteUrlMaybe(url: string | null, req: NextRequest): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, req.nextUrl.origin).toString();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const artifactId = req.nextUrl.searchParams.get("artifactId")?.trim() ?? "";
  const bundleModeParam = req.nextUrl.searchParams.get("bundleMode")?.trim() ?? "";
  const bundleMode: BundleMode =
    bundleModeParam === "same_node" || bundleModeParam === "project_fallback"
      ? bundleModeParam
      : "project_fallback";
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
      ...(selectedArtifact.runId && selectedArtifact.nodeId
        ? {
            runId: selectedArtifact.runId,
            nodeId: selectedArtifact.nodeId
          }
        : selectedArtifact.runId
        ? { runId: selectedArtifact.runId }
        : { id: selectedArtifact.id })
    },
    orderBy: { createdAt: "desc" },
    take: 220
  });
  let artifacts = uniqueById([selectedArtifact, ...relatedArtifacts]);

  const hasMeshInPrimary = artifacts.some((artifact) => artifact.kind === "mesh_glb");
  const hasSplatInPrimary = artifacts.some(
    (artifact) => artifact.kind === "point_ply" || artifact.kind === "splat_ksplat"
  );

  if (selectedArtifact.nodeId && (!hasMeshInPrimary || !hasSplatInPrimary)) {
    const sameNodeArtifacts = await prisma.artifact.findMany({
      where: {
        projectId: selectedArtifact.projectId,
        nodeId: selectedArtifact.nodeId
      },
      orderBy: { createdAt: "desc" },
      take: 420
    });

    if (!hasMeshInPrimary) {
      const latestMeshArtifact = sameNodeArtifacts.find((artifact) => artifact.kind === "mesh_glb");
      if (latestMeshArtifact) {
        artifacts = uniqueById([...artifacts, latestMeshArtifact]);
      }
    }

    if (!hasSplatInPrimary) {
      const latestSplatArtifact = sameNodeArtifacts.find(
        (artifact) => artifact.kind === "point_ply" || artifact.kind === "splat_ksplat"
      );
      if (latestSplatArtifact) {
        artifacts = uniqueById([...artifacts, latestSplatArtifact]);
      }
    }
  }

  if (bundleMode === "project_fallback") {
    const hasMeshAfterNodeFallback = artifacts.some((artifact) => artifact.kind === "mesh_glb");
    const hasSplatAfterNodeFallback = artifacts.some(
      (artifact) => artifact.kind === "point_ply" || artifact.kind === "splat_ksplat"
    );
    if (!hasMeshAfterNodeFallback || !hasSplatAfterNodeFallback) {
      const projectFallbackArtifacts = await prisma.artifact.findMany({
        where: {
          projectId: selectedArtifact.projectId
        },
        orderBy: { createdAt: "desc" },
        take: 420
      });

      if (!hasMeshAfterNodeFallback) {
        const latestProjectMesh = projectFallbackArtifacts.find((artifact) => artifact.kind === "mesh_glb");
        if (latestProjectMesh) {
          artifacts = uniqueById([...artifacts, latestProjectMesh]);
        }
      }

      if (!hasSplatAfterNodeFallback) {
        const latestProjectSplat = projectFallbackArtifacts.find(
          (artifact) => artifact.kind === "point_ply" || artifact.kind === "splat_ksplat"
        );
        if (latestProjectSplat) {
          artifacts = uniqueById([...artifacts, latestProjectSplat]);
        }
      }
    }
  }

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
  const meshSeen = new Set<string>();
  const pushMeshUrl = (params: {
    artifact: Artifact;
    url: string;
    idSuffix?: string;
  }) => {
    const dedupKey = normalizeUrlForDedup(params.url);
    if (meshSeen.has(dedupKey)) return false;
    meshSeen.add(dedupKey);
    meshes.push({
      id: params.idSuffix
        ? `mesh-${params.artifact.id}-${params.idSuffix}`
        : `mesh-${params.artifact.id}`,
      artifactId: params.artifact.id,
      runId: params.artifact.runId,
      nodeId: params.artifact.nodeId,
      kind: params.artifact.kind,
      url: params.url
    });
    return true;
  };
  for (const meshArtifact of meshArtifacts) {
    const rawMeta = meshArtifact.meta;
    const meta =
      rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
        ? (rawMeta as ArtifactMetaLike)
        : null;
    const extraStorageKeys = Array.isArray(meta?.meshObjectStorageKeys)
      ? meta.meshObjectStorageKeys.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      : [];

    let extraCount = 0;
    for (const storageKey of extraStorageKeys) {
      const extraRawUrl = await safeGetSignedDownloadUrl(storageKey);
      const extraUrl = toAbsoluteUrlMaybe(extraRawUrl, req);
      if (!extraUrl) continue;
      if (pushMeshUrl({ artifact: meshArtifact, url: extraUrl, idSuffix: `extra-${extraCount}` })) {
        extraCount += 1;
      }
    }

    // If object-level mesh keys are present, they are the authoritative object list.
    // Only fallback to base mesh URL when extras are unavailable.
    if (extraStorageKeys.length === 0 || extraCount === 0) {
      const rawUrl = await safeGetSignedDownloadUrl(meshArtifact.storageKey);
      const url = toAbsoluteUrlMaybe(rawUrl, req);
      if (url) {
        pushMeshUrl({ artifact: meshArtifact, url });
      }
    }
  }

  const splats: WorldManifestSplatEntry[] = [];
  const splatSeen = new Set<string>();
  for (const splatArtifact of splatArtifacts) {
    const sourceUrl = toAbsoluteUrlMaybe(await safeGetSignedDownloadUrl(splatArtifact.storageKey), req);
    const sourceDedupKey = sourceUrl ? normalizeUrlForDedup(sourceUrl) : null;
    if (!sourceDedupKey || splatSeen.has(sourceDedupKey)) continue;
    splatSeen.add(sourceDedupKey);
    const tilesetArtifact = latestTilesetBySourceArtifact.get(splatArtifact.id) ?? null;
    const tilesetUrl = tilesetArtifact
      ? `${req.nextUrl.origin}/api/storage/object?key=${encodeURIComponent(tilesetArtifact.storageKey)}`
      : null;
    const tilesetMeta = tilesetArtifact ? parseTilesetMeta(tilesetArtifact) : null;
    splats.push({
      id: `splat-${splatArtifact.id}`,
      artifactId: splatArtifact.id,
      runId: splatArtifact.runId,
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
  const meshRunIds = uniqueStrings(meshes.map((entry) => entry.runId));
  const splatRunIds = uniqueStrings(splats.map((entry) => entry.runId));
  const selectedRunId = selectedArtifact.runId ?? null;
  const usedCrossRunFallback = Boolean(
    selectedRunId &&
      (meshRunIds.some((runId) => runId !== selectedRunId) ||
        splatRunIds.some((runId) => runId !== selectedRunId))
  );

  return NextResponse.json({
    artifactId: selectedArtifact.id,
    projectId: selectedArtifact.projectId,
    context: {
      selectedRunId,
      selectedNodeId: selectedArtifact.nodeId ?? null
    },
    bundle: {
      mode: bundleMode,
      meshRunIds,
      splatRunIds,
      usedCrossRunFallback
    },
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
