import { NextRequest, NextResponse } from "next/server";

import { Artifact } from "@prisma/client";

import { requireArtifactAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getObjectBuffer } from "@/lib/storage/s3";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";
import { assertProjectStorageKeyAccess } from "@/lib/storage/access";
import { worldManifestQuerySchema } from "@/lib/validation/schemas";

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

type WorldManifestLightType = "ambient" | "point" | "spot" | "directional";

interface WorldManifestLight {
  id: string;
  type: WorldManifestLightType;
  label: string;
  enabled: boolean;
  color: string;
  intensity: number;
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
  decay: number;
  angle: number;
  penumbra: number;
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
  lights: WorldManifestLight[];
}

interface WorldManifestCameraPathFrame {
  index: number;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

interface WorldManifestCameraPath {
  artifactId: string;
  frameCount: number;
  isMetric: boolean;
  modelVariant: string | null;
  frames: WorldManifestCameraPathFrame[];
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
  groundColor: "#101828",
  lights: [
    {
      id: "ambient-default",
      type: "ambient",
      label: "Ambient Light",
      enabled: true,
      color: "#ffffff",
      intensity: 1.1,
      position: [0, 0, 0],
      target: [0, 0, 0],
      distance: 0,
      decay: 2,
      angle: 30,
      penumbra: 0.25
    }
  ]
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

function normalizeLightType(value: unknown): WorldManifestLightType | null {
  if (value === "ambient" || value === "point" || value === "spot" || value === "directional") return value;
  return null;
}

function normalizeVector3Tuple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [0, 1, 2].map((index) => {
    const parsed = Number(value[index]);
    return Number.isFinite(parsed) ? parsed : fallback[index];
  }) as [number, number, number];
}

function makeLightDefaults(type: WorldManifestLightType, id: string): WorldManifestLight {
  if (type === "ambient") {
    return {
      ...DEFAULT_ENVIRONMENT.lights[0],
      id,
      label: "Ambient Light"
    };
  }
  if (type === "spot") {
    return {
      id,
      type,
      label: "Spot Light",
      enabled: true,
      color: "#ffffff",
      intensity: 2.5,
      position: [2.5, 4, 2.5],
      target: [0, 0, 0],
      distance: 18,
      decay: 2,
      angle: 28,
      penumbra: 0.35
    };
  }
  if (type === "point") {
    return {
      id,
      type,
      label: "Point Light",
      enabled: true,
      color: "#ffffff",
      intensity: 3,
      position: [2, 3, 2],
      target: [0, 0, 0],
      distance: 16,
      decay: 2,
      angle: 30,
      penumbra: 0.25
    };
  }
  return {
    id,
    type,
    label: "Directional Light",
    enabled: true,
    color: "#ffffff",
    intensity: 1.2,
    position: [4, 6, 3],
    target: [0, 0, 0],
    distance: 0,
    decay: 2,
    angle: 30,
    penumbra: 0.25
  };
}

function normalizeLightConfig(raw: unknown, index: number): WorldManifestLight | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const type = normalizeLightType(record.type);
  if (!type) return null;
  const fallback = makeLightDefaults(type, `${type}-${index}`);
  const idRaw = typeof record.id === "string" ? record.id.trim() : "";
  const labelRaw = typeof record.label === "string" ? record.label.trim() : "";
  return {
    ...fallback,
    id: idRaw.length > 0 ? idRaw.slice(0, 80) : fallback.id,
    label: labelRaw.length > 0 ? labelRaw.slice(0, 80) : fallback.label,
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    color: sanitizeColor(record.color, fallback.color),
    intensity: clamp(Number.isFinite(Number(record.intensity)) ? Number(record.intensity) : fallback.intensity, 0, 20),
    position: normalizeVector3Tuple(record.position, fallback.position),
    target: normalizeVector3Tuple(record.target, fallback.target),
    distance: clamp(Number.isFinite(Number(record.distance)) ? Number(record.distance) : fallback.distance, 0, 200),
    decay: clamp(Number.isFinite(Number(record.decay)) ? Number(record.decay) : fallback.decay, 0, 8),
    angle: clamp(Number.isFinite(Number(record.angle)) ? Number(record.angle) : fallback.angle, 1, 89),
    penumbra: clamp(Number.isFinite(Number(record.penumbra)) ? Number(record.penumbra) : fallback.penumbra, 0, 1)
  };
}

function parseLightsJson(value: unknown): unknown {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeLightsConfig(raw: unknown, params: Record<string, unknown>, ambientIntensity: number, sunColor: string): WorldManifestLight[] {
  const source = Array.isArray(raw) ? raw : parseLightsJson(params.lightsJson);
  if (Array.isArray(source)) {
    const lights = source
      .map((entry, index) => normalizeLightConfig(entry, index))
      .filter((entry): entry is WorldManifestLight => Boolean(entry));
    if (lights.length > 0) return lights;
  }
  return [
    {
      ...DEFAULT_ENVIRONMENT.lights[0],
      color: sunColor,
      intensity: ambientIntensity
    }
  ];
}

function normalizeEnvironmentConfig(raw: Record<string, unknown> | null | undefined): WorldManifestEnvironment {
  const params = raw ?? {};
  const hdriUrlRaw = typeof params.hdriUrl === "string" ? params.hdriUrl.trim() : "";
  const ambientIntensity = clamp(
    Number.isFinite(Number(params.ambientIntensity)) ? Number(params.ambientIntensity) : DEFAULT_ENVIRONMENT.ambientIntensity,
    0,
    8
  );
  const sunColor = sanitizeColor(params.sunColor, DEFAULT_ENVIRONMENT.sunColor);
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
    ambientIntensity,
    sunIntensity: clamp(
      Number.isFinite(Number(params.sunIntensity)) ? Number(params.sunIntensity) : DEFAULT_ENVIRONMENT.sunIntensity,
      0,
      8
    ),
    sunColor,
    groundColor: sanitizeColor(params.groundColor, DEFAULT_ENVIRONMENT.groundColor),
    lights: normalizeLightsConfig(params.lights, params, ambientIntensity, sunColor)
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

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asNumberMatrix(value: unknown, rows: number, cols: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== rows) return null;
  const matrix = value.map((row) => {
    if (!Array.isArray(row) || row.length !== cols) return null;
    const values = row.map(asFiniteNumber);
    return values.every((entry): entry is number => entry !== null) ? values : null;
  });
  if (matrix.some((row) => row === null)) return null;
  return matrix as number[][];
}

function normalizeVector(value: [number, number, number], fallback: [number, number, number]) {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= 1e-8) return fallback;
  return [value[0] / length, value[1] / length, value[2] / length] as [number, number, number];
}

function inferFovFromIntrinsics(intrinsic: number[][] | null) {
  if (!intrinsic) return 50;
  const fy = Math.abs(intrinsic[1]?.[1] ?? 0);
  const cy = Math.abs(intrinsic[1]?.[2] ?? 0);
  const height = cy > 0 ? cy * 2 : 0;
  if (fy <= 0 || height <= 0) return 50;
  return clamp((2 * Math.atan(height / (2 * fy)) * 180) / Math.PI, 5, 140);
}

function transpose3(matrix: number[][]) {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]]
  ];
}

function mulMat3Vec3(matrix: number[][], vector: [number, number, number]): [number, number, number] {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
  ];
}

function transformPoint4(matrix: number[][], point: [number, number, number]): [number, number, number] {
  const x = matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2] * point[2] + matrix[0][3];
  const y = matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2] * point[2] + matrix[1][3];
  const z = matrix[2][0] * point[0] + matrix[2][1] * point[1] + matrix[2][2] * point[2] + matrix[2][3];
  const w = matrix[3][0] * point[0] + matrix[3][1] * point[1] + matrix[3][2] * point[2] + matrix[3][3];
  if (Math.abs(w) > 1e-8 && Math.abs(w - 1) > 1e-8) {
    return [x / w, y / w, z / w];
  }
  return [x, y, z];
}

function transformDirection4(matrix: number[][], direction: [number, number, number]): [number, number, number] {
  return [
    matrix[0][0] * direction[0] + matrix[0][1] * direction[1] + matrix[0][2] * direction[2],
    matrix[1][0] * direction[0] + matrix[1][1] * direction[1] + matrix[1][2] * direction[2],
    matrix[2][0] * direction[0] + matrix[2][1] * direction[1] + matrix[2][2] * direction[2]
  ];
}

function frameFromDa3Camera(
  extrinsic: number[][],
  intrinsic: number[][] | null,
  index: number,
  viewerAlignment: number[][] | null
): WorldManifestCameraPathFrame {
  const rotationWorldToCamera = [
    [extrinsic[0][0], extrinsic[0][1], extrinsic[0][2]],
    [extrinsic[1][0], extrinsic[1][1], extrinsic[1][2]],
    [extrinsic[2][0], extrinsic[2][1], extrinsic[2][2]]
  ];
  const rotationCameraToWorld = transpose3(rotationWorldToCamera);
  const translation: [number, number, number] = [extrinsic[0][3], extrinsic[1][3], extrinsic[2][3]];
  const cameraCenter = mulMat3Vec3(rotationCameraToWorld, translation);
  const position: [number, number, number] = [-cameraCenter[0], -cameraCenter[1], -cameraCenter[2]];
  const forward = normalizeVector(mulMat3Vec3(rotationCameraToWorld, [0, 0, 1]), [0, 0, 1]);
  const up = normalizeVector(mulMat3Vec3(rotationCameraToWorld, [0, -1, 0]), [0, 1, 0]);
  let target: [number, number, number] = [
    position[0] + forward[0],
    position[1] + forward[1],
    position[2] + forward[2]
  ];
  let alignedPosition = position;
  let alignedUp = up;

  if (viewerAlignment) {
    alignedPosition = transformPoint4(viewerAlignment, position);
    target = transformPoint4(viewerAlignment, target);
    alignedUp = normalizeVector(transformDirection4(viewerAlignment, up), [0, 1, 0]);
  }

  return {
    index,
    position: alignedPosition,
    target,
    up: alignedUp,
    fov: inferFovFromIntrinsics(intrinsic)
  };
}

async function readCameraPathFromArtifact(
  artifact: Artifact,
  fallbackViewerAlignment: number[][] | null = null
): Promise<WorldManifestCameraPath | null> {
  const meta =
    artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)
      ? (artifact.meta as Record<string, unknown>)
      : {};
  if (meta.outputKey !== "camera" && meta.artifactType !== "Descriptor") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse((await getObjectBuffer(artifact.storageKey)).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const extrinsicsRaw = Array.isArray(record.extrinsics) ? record.extrinsics : [];
  const intrinsicsRaw = Array.isArray(record.intrinsics) ? record.intrinsics : [];
  const viewerAlignment = asNumberMatrix(record.viewer_alignment, 4, 4) ?? fallbackViewerAlignment;
  const frames: WorldManifestCameraPathFrame[] = [];

  for (let index = 0; index < extrinsicsRaw.length; index += 1) {
    const extrinsic = asNumberMatrix(extrinsicsRaw[index], 3, 4);
    if (!extrinsic) continue;
    const intrinsic = asNumberMatrix(intrinsicsRaw[index], 3, 3);
    frames.push(frameFromDa3Camera(extrinsic, intrinsic, index, viewerAlignment));
  }

  if (frames.length === 0) return null;
  return {
    artifactId: artifact.id,
    frameCount: frames.length,
    isMetric: record.is_metric === 1 || record.is_metric === true,
    modelVariant: typeof record.model_variant === "string" ? record.model_variant : null,
    frames
  };
}

function readGlbJsonChunk(buffer: Buffer): Record<string, unknown> | null {
  if (buffer.length < 20 || buffer.toString("utf8", 0, 4) !== "glTF") return null;
  const version = buffer.readUInt32LE(4);
  if (version !== 2) return null;
  const jsonLength = buffer.readUInt32LE(12);
  const chunkType = buffer.toString("utf8", 16, 20);
  if (chunkType !== "JSON" || jsonLength <= 0 || 20 + jsonLength > buffer.length) return null;
  try {
    return JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findViewerAlignmentInGlbJson(json: Record<string, unknown>): number[][] | null {
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) continue;
    const extras = (scene as Record<string, unknown>).extras;
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) continue;
    const alignment = asNumberMatrix((extras as Record<string, unknown>).hf_alignment, 4, 4);
    if (alignment) return alignment;
  }
  return null;
}

async function readViewerAlignmentFromGlbArtifact(artifact: Artifact): Promise<number[][] | null> {
  if (artifact.kind !== "mesh_glb") return null;
  try {
    const buffer = await getObjectBuffer(artifact.storageKey);
    const json = readGlbJsonChunk(buffer);
    return json ? findViewerAlignmentInGlbJson(json) : null;
  } catch {
    return null;
  }
}

async function resolveCameraPathArtifact(selectedArtifact: Artifact) {
  const selectedMeta =
    selectedArtifact.meta && typeof selectedArtifact.meta === "object" && !Array.isArray(selectedArtifact.meta)
      ? (selectedArtifact.meta as Record<string, unknown>)
      : {};
  if (selectedMeta.outputKey === "camera" || selectedMeta.artifactType === "Descriptor") {
    return selectedArtifact;
  }

  if (!selectedArtifact.runId || !selectedArtifact.nodeId) return null;
  return prisma.artifact.findFirst({
    where: {
      projectId: selectedArtifact.projectId,
      runId: selectedArtifact.runId,
      nodeId: selectedArtifact.nodeId,
      kind: "json",
      meta: {
        path: ["outputKey"],
        equals: "camera"
      }
    },
    orderBy: { createdAt: "desc" }
  });
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
  try {
    const parsedQuery = worldManifestQuerySchema.safeParse({
      artifactId: req.nextUrl.searchParams.get("artifactId"),
      bundleMode: req.nextUrl.searchParams.get("bundleMode")
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid manifest query", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const artifactId = parsedQuery.data.artifactId;
    const requestedBundleMode = parsedQuery.data.bundleMode ?? "project_fallback";
    const bundleMode: BundleMode = "same_node";
    const access = await requireArtifactAccess(artifactId, "viewer");
    await enforceRateLimit({
      bucket: "signed-url:manifest",
      identifier: access.user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Manifest signed URL rate limit exceeded"
    });

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

    const warnings: string[] = [];
    if (requestedBundleMode !== "same_node") {
      warnings.push("Project fallback is disabled. Viewer now loads only selected run/version artifacts.");
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

    const artifacts = [selectedArtifact];

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
        await assertProjectStorageKeyAccess(selectedArtifact.projectId, storageKey);
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
    const usedCrossRunFallback = false;
    const selectedArtifactViewerAlignment = await readViewerAlignmentFromGlbArtifact(selectedArtifact);
    const cameraPathArtifact = await resolveCameraPathArtifact(selectedArtifact);
    const cameraPath = cameraPathArtifact
      ? await readCameraPathFromArtifact(cameraPathArtifact, selectedArtifactViewerAlignment)
      : null;

    if (meshes.length === 0 && splats.length === 0) {
      warnings.push(
        cameraPath
          ? "Selected run/version has no loadable scene artifacts. Rendering camera path only."
          : "Selected run/version has no loadable scene artifacts for this viewer node. Rendering empty scene."
      );
    }

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
          await assertProjectStorageKeyAccess(selectedArtifact.projectId, hdriStorageKey);
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

    await logAuditEventFromRequest(req, {
      action: "viewer_manifest_access",
      resourceType: "artifact",
      resourceId: selectedArtifact.id,
      projectId: selectedArtifact.projectId,
      userId: access.user.id
    });

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
      warnings,
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
      cameraPath,
      meshes,
      splats,
      build: {
        canBuildTileset,
        defaultPresetName: "Default"
      }
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to load world manifest");
  }
}
