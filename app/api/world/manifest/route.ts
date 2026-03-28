import { NextRequest, NextResponse } from "next/server";

import { Artifact } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getObjectBuffer } from "@/lib/storage/s3";
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

interface WorldManifestEnvironment {
  enabled: boolean;
  hdriUrl: string | null;
  backgroundMode: "solid" | "hdri" | "transparent";
  backgroundColor: string;
  toneMapping: "ACESFilmic" | "Neutral" | "Reinhard" | "None";
  exposure: number;
  envIntensity: number;
  hdriRotationY: number;
  hdriBlur: number;
  ambientIntensity: number;
  sunIntensity: number;
  sunColor: string;
  groundColor: string;
}

interface GraphNodeLike {
  id: string;
  type: string;
  data?: {
    params?: Record<string, unknown>;
  };
}

interface GraphEdgeLike {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

const DEFAULT_ENVIRONMENT: WorldManifestEnvironment = {
  enabled: true,
  hdriUrl: null,
  backgroundMode: "solid",
  backgroundColor: "#05070e",
  toneMapping: "ACESFilmic",
  exposure: 1,
  envIntensity: 1,
  hdriRotationY: 0,
  hdriBlur: 0,
  ambientIntensity: 1.1,
  sunIntensity: 1.2,
  sunColor: "#ffffff",
  groundColor: "#101828"
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeColor(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized) ? normalized : fallback;
}

function normalizeBackgroundMode(value: unknown): WorldManifestEnvironment["backgroundMode"] {
  if (value === "hdri" || value === "transparent") return value;
  return "solid";
}

function normalizeToneMapping(value: unknown): WorldManifestEnvironment["toneMapping"] {
  if (value === "Neutral" || value === "Reinhard" || value === "None") return value;
  return "ACESFilmic";
}

function normalizeEnvironmentConfig(raw: Record<string, unknown> | null | undefined): WorldManifestEnvironment {
  const params = raw ?? {};
  const hdriUrlRaw = typeof params.hdriUrl === "string" ? params.hdriUrl.trim() : "";
  return {
    enabled: params.enabled !== false,
    hdriUrl: hdriUrlRaw.length > 0 ? hdriUrlRaw : null,
    backgroundMode: normalizeBackgroundMode(params.backgroundMode),
    backgroundColor: sanitizeColor(params.backgroundColor, DEFAULT_ENVIRONMENT.backgroundColor),
    toneMapping: normalizeToneMapping(params.toneMapping),
    exposure: clamp(Number.isFinite(Number(params.exposure)) ? Number(params.exposure) : DEFAULT_ENVIRONMENT.exposure, 0, 6),
    envIntensity: clamp(
      Number.isFinite(Number(params.envIntensity)) ? Number(params.envIntensity) : DEFAULT_ENVIRONMENT.envIntensity,
      0,
      8
    ),
    hdriRotationY: clamp(
      Number.isFinite(Number(params.hdriRotationY)) ? Number(params.hdriRotationY) : DEFAULT_ENVIRONMENT.hdriRotationY,
      -180,
      180
    ),
    hdriBlur: clamp(
      Number.isFinite(Number(params.hdriBlur)) ? Number(params.hdriBlur) : DEFAULT_ENVIRONMENT.hdriBlur,
      0,
      1
    ),
    ambientIntensity: clamp(
      Number.isFinite(Number(params.ambientIntensity)) ? Number(params.ambientIntensity) : DEFAULT_ENVIRONMENT.ambientIntensity,
      0,
      8
    ),
    sunIntensity: clamp(
      Number.isFinite(Number(params.sunIntensity)) ? Number(params.sunIntensity) : DEFAULT_ENVIRONMENT.sunIntensity,
      0,
      8
    ),
    sunColor: sanitizeColor(params.sunColor, DEFAULT_ENVIRONMENT.sunColor),
    groundColor: sanitizeColor(params.groundColor, DEFAULT_ENVIRONMENT.groundColor)
  };
}

function parseGraphDocument(raw: unknown): { nodes: GraphNodeLike[]; edges: GraphEdgeLike[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const nodesRaw = Array.isArray(record.nodes) ? record.nodes : [];
  const edgesRaw = Array.isArray(record.edges) ? record.edges : [];

  const nodes = nodesRaw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const data =
        entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
          ? (entry.data as Record<string, unknown>)
          : {};
      const params =
        data.params && typeof data.params === "object" && !Array.isArray(data.params)
          ? (data.params as Record<string, unknown>)
          : {};
      return {
        id: typeof entry.id === "string" ? entry.id : "",
        type: typeof entry.type === "string" ? entry.type : "",
        data: { params }
      };
    })
    .filter((node) => node.id.length > 0 && node.type.length > 0);

  const edges = edgesRaw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      source: typeof entry.source === "string" ? entry.source : "",
      target: typeof entry.target === "string" ? entry.target : "",
      sourceHandle: typeof entry.sourceHandle === "string" ? entry.sourceHandle : null,
      targetHandle: typeof entry.targetHandle === "string" ? entry.targetHandle : null
    }))
    .filter((edge) => edge.source.length > 0 && edge.target.length > 0);

  return { nodes, edges };
}

function normalizeViewerTargetHandle(handle: string | null | undefined) {
  if (!handle || handle.length === 0) return "artifact";
  if (handle === "scene" || handle === "json") return "artifact";
  if (handle === "env" || handle === "hdri" || handle === "lighting") return "environment";
  return handle;
}

function readEnvironmentFromMeta(meta: unknown): WorldManifestEnvironment | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const source =
    record.environment && typeof record.environment === "object" && !Array.isArray(record.environment)
      ? (record.environment as Record<string, unknown>)
      : record;
  return normalizeEnvironmentConfig(source);
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
    const parsed = new URL(url, "http://localhost");
    const key = parsed.searchParams.get("key");
    if (parsed.pathname === "/api/storage/object" && key) {
      return `storage:${key}`;
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

  const selectedRun = selectedArtifact.runId
    ? await prisma.run.findUnique({
        where: { id: selectedArtifact.runId },
        select: {
          graph: {
            select: {
              graphJson: true
            }
          }
        }
      })
    : null;
  const parsedGraph = parseGraphDocument(selectedRun?.graph?.graphJson ?? null);

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

  let resolvedEnvironment: WorldManifestEnvironment | null = null;
  let environmentNodeId: string | null = null;
  let environmentViewerNodeId: string | null = null;
  if (parsedGraph) {
    const nodesById = new Map(parsedGraph.nodes.map((node) => [node.id, node]));
    const selectedNodeId = selectedArtifact.nodeId ?? null;

    if (selectedNodeId) {
      const connectedViewerNodeIds = parsedGraph.edges
        .filter((edge) => edge.source === selectedNodeId)
        .filter((edge) => nodesById.get(edge.target)?.type === "out.open_in_viewer")
        .filter((edge) => normalizeViewerTargetHandle(edge.targetHandle) === "artifact")
        .map((edge) => edge.target);

      const environmentEdge = parsedGraph.edges.find((edge) => {
        if (!connectedViewerNodeIds.includes(edge.target)) return false;
        if (normalizeViewerTargetHandle(edge.targetHandle) !== "environment") return false;
        return nodesById.get(edge.source)?.type === "viewer.environment";
      });
      if (environmentEdge) {
        environmentNodeId = environmentEdge.source;
        environmentViewerNodeId = environmentEdge.target;
      }
    }

    if (!environmentNodeId) {
      const environmentNodes = parsedGraph.nodes.filter((node) => node.type === "viewer.environment");
      if (environmentNodes.length === 1) {
        environmentNodeId = environmentNodes[0].id;
      }
    }

    if (environmentNodeId) {
      const environmentNode = nodesById.get(environmentNodeId);
      const graphParams =
        environmentNode?.data?.params && typeof environmentNode.data.params === "object"
          ? (environmentNode.data.params as Record<string, unknown>)
          : null;
      const graphEnvironment = normalizeEnvironmentConfig(graphParams ?? undefined);
      let artifactEnvironment: WorldManifestEnvironment | null = null;

      const localCandidate = artifacts
        .filter((artifact) => artifact.nodeId === environmentNodeId && artifact.kind === "json")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const dbCandidates = localCandidate
        ? [localCandidate]
        : await prisma.artifact.findMany({
            where: {
              projectId: selectedArtifact.projectId,
              nodeId: environmentNodeId,
              kind: "json"
            },
            orderBy: { createdAt: "desc" },
            take: 8
          });

      for (const candidate of dbCandidates) {
        const fromMeta = readEnvironmentFromMeta(candidate.meta);
        if (fromMeta) {
          artifactEnvironment = fromMeta;
          break;
        }
        try {
          const raw = await getObjectBuffer(candidate.storageKey);
          const parsed = JSON.parse(raw.toString("utf8")) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const fromBody = normalizeEnvironmentConfig(parsed as Record<string, unknown>);
            artifactEnvironment = fromBody;
            break;
          }
        } catch {
          // Continue with next candidate.
        }
      }

      const hdriStorageKey =
        graphParams && typeof graphParams.hdriStorageKey === "string" && graphParams.hdriStorageKey.trim().length > 0
          ? graphParams.hdriStorageKey.trim()
          : null;
      let hdriUrlFromStorage: string | null = null;
      if (hdriStorageKey) {
        const rawUrl = await safeGetSignedDownloadUrl(hdriStorageKey);
        hdriUrlFromStorage = toAbsoluteUrlMaybe(rawUrl, req);
      }

      resolvedEnvironment = {
        ...DEFAULT_ENVIRONMENT,
        ...(artifactEnvironment ?? {}),
        ...graphEnvironment,
        hdriUrl: hdriUrlFromStorage ?? graphEnvironment.hdriUrl ?? artifactEnvironment?.hdriUrl ?? null
      };
    }
  }

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
    environment: resolvedEnvironment,
    environmentContext: {
      nodeId: environmentNodeId,
      viewerNodeId: environmentViewerNodeId
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
