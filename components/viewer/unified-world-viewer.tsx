"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { Camera, Crosshair, Download, MoveHorizontal, Navigation, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  alignSceneToGroundPlane,
  type GroundAlignOptions
} from "@/lib/viewer/ground-plane-alignment";
import { getSplatRuntimePreference, isSparkRuntimeEnabled } from "@/lib/viewer/splat-runtime-config";
import { cn } from "@/lib/utils";

interface WorldManifest {
  artifactId?: string;
  camera?: {
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
  };
  environment?: {
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
  } | null;
  meshes: Array<{ id: string; url: string; formatHint?: "ply" | "glb" | "gltf" | null }>;
  splats: Array<{
    id: string;
    tilesetUrl: string | null;
    sourceUrl: string | null;
    formatHint?: "ply" | "splat" | "ksplat" | "spz" | null;
  }>;
}

type ViewerEnvironmentConfig = NonNullable<WorldManifest["environment"]>;

type NavigationMode = "orbit" | "fly";
type SplatLoadProfile = "full" | "balanced" | "preview";
type FloatingPanel = "none" | "file" | "settings" | "hud" | "objects" | "transform";
type BundleMode = "same_node" | "project_fallback";
type SplatRuntimeName = "legacy" | "spark";
type LoadedSplatRuntime = SplatRuntimeName | "points";
type ViewMode = "default" | "modelviewer";
type TransformMode = "translate" | "rotate" | "scale";
type TransformSpace = "world" | "local";

interface ViewerFileMenuOption {
  id: string;
  kind: string;
  href: string;
  label: string;
  selected: boolean;
}

interface ViewerFileMenu {
  selectedKind: string | null;
  activeNodeScope: string | null;
  rendererLabel: string | null;
  selectedArtifactText: string;
  options: ViewerFileMenuOption[];
  sourceLabel: string;
  viewerLabel: string;
  canUseRunArtifact: boolean;
  canBuildTileset: boolean;
  buildTilesetLoading: boolean;
  bundleSourceNote?: string | null;
  bundleMode: BundleMode;
  onPickLocalFile: () => void;
  onAddExternalFile?: () => void;
  onUseRunArtifact?: () => void;
  onBuildTileset?: () => void;
  onBundleModeChange?: (mode: BundleMode) => void;
  onDeleteArtifact?: (artifactId: string, label?: string) => void;
  deletingArtifactId?: string | null;
  onClearScene?: () => void;
  onResetViewer?: () => void;
}

interface ExternalSceneAddition {
  id: string;
  kind: string;
  url: string;
  filename?: string | null;
}

interface MeshTransformRecord {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface PersistedViewerTransforms {
  meshes: Record<string, MeshTransformRecord>;
  splats: Record<string, MeshTransformRecord>;
  sceneAlignment: MeshTransformRecord | null;
}

interface MeshListItem {
  id: string;
  label: string;
}

type SelectableSceneObjectKind = "mesh" | "splat";
type SceneObjectKind = SelectableSceneObjectKind | "group";

interface SplatListItem {
  id: string;
  label: string;
  splatCount: number;
}

interface ActiveGroupMember {
  key: string;
  kind: SelectableSceneObjectKind;
  id: string;
  label: string;
  object: THREE.Object3D;
  baselineLocal: MeshTransformRecord;
}

interface ActiveObjectGroup {
  id: string;
  name: string;
  members: ActiveGroupMember[];
  initialTransform: MeshTransformRecord;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

interface TransformDraft {
  position: [string, string, string];
  rotation: [string, string, string];
  scale: [string, string, string];
}
type EulerTriplet = [number, number, number];

interface SplatHandle {
  id: string;
  label: string;
  object: THREE.Object3D;
  runtime: LoadedSplatRuntime;
  sourceKey?: string;
  sourceUrl?: string;
  formatHint?: "ply" | "splat" | "ksplat" | "spz" | null;
  dispose?: () => void;
  update?: () => void;
  splatCount?: number;
  bounds?: THREE.Box3;
}

interface ObjectContextMenuState {
  x: number;
  y: number;
  itemId: string;
  kind: SelectableSceneObjectKind;
  label: string;
}

interface ArtifactContextMenuState {
  x: number;
  y: number;
  artifactId: string;
  label: string;
}

interface ViewerHudStats {
  visibleTiles: number;
  loadedTiles: number;
  loadedSplats: number;
  loadedMB: number;
  activeLodDistribution: { "0": number; "1": number; "2": number };
}

const DEFAULT_STATS: ViewerHudStats = {
  visibleTiles: 0,
  loadedTiles: 0,
  loadedSplats: 0,
  loadedMB: 0,
  activeLodDistribution: { "0": 0, "1": 0, "2": 0 }
};

const DEFAULT_VIEWER_ENVIRONMENT: ViewerEnvironmentConfig = {
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

function normalizeEnvironmentConfig(input: WorldManifest["environment"] | null | undefined): ViewerEnvironmentConfig {
  const base = input ?? null;
  const hdriUrlRaw = typeof base?.hdriUrl === "string" ? base.hdriUrl.trim() : "";
  return {
    ...DEFAULT_VIEWER_ENVIRONMENT,
    ...(base ?? {}),
    hdriUrl: hdriUrlRaw.length > 0 ? hdriUrlRaw : null,
    backgroundColor: safeColorOrFallback(
      base?.backgroundColor ?? DEFAULT_VIEWER_ENVIRONMENT.backgroundColor,
      DEFAULT_VIEWER_ENVIRONMENT.backgroundColor
    ),
    sunColor: safeColorOrFallback(
      base?.sunColor ?? DEFAULT_VIEWER_ENVIRONMENT.sunColor,
      DEFAULT_VIEWER_ENVIRONMENT.sunColor
    ),
    groundColor: safeColorOrFallback(
      base?.groundColor ?? DEFAULT_VIEWER_ENVIRONMENT.groundColor,
      DEFAULT_VIEWER_ENVIRONMENT.groundColor
    ),
    exposure: clampRange(
      Number.isFinite(Number(base?.exposure)) ? Number(base?.exposure) : DEFAULT_VIEWER_ENVIRONMENT.exposure,
      0,
      6
    ),
    envIntensity: clampRange(
      Number.isFinite(Number(base?.envIntensity)) ? Number(base?.envIntensity) : DEFAULT_VIEWER_ENVIRONMENT.envIntensity,
      0,
      8
    ),
    hdriRotationY: clampRange(
      Number.isFinite(Number(base?.hdriRotationY)) ? Number(base?.hdriRotationY) : DEFAULT_VIEWER_ENVIRONMENT.hdriRotationY,
      -180,
      180
    ),
    hdriBlur: clampRange(
      Number.isFinite(Number(base?.hdriBlur)) ? Number(base?.hdriBlur) : DEFAULT_VIEWER_ENVIRONMENT.hdriBlur,
      0,
      1
    ),
    ambientIntensity: clampRange(
      Number.isFinite(Number(base?.ambientIntensity))
        ? Number(base?.ambientIntensity)
        : DEFAULT_VIEWER_ENVIRONMENT.ambientIntensity,
      0,
      8
    ),
    sunIntensity: clampRange(
      Number.isFinite(Number(base?.sunIntensity)) ? Number(base?.sunIntensity) : DEFAULT_VIEWER_ENVIRONMENT.sunIntensity,
      0,
      8
    ),
    toneMapping:
      base?.toneMapping === "None" ||
      base?.toneMapping === "Reinhard" ||
      base?.toneMapping === "Neutral" ||
      base?.toneMapping === "ACESFilmic"
        ? base.toneMapping
        : DEFAULT_VIEWER_ENVIRONMENT.toneMapping,
    backgroundMode:
      base?.backgroundMode === "transparent" || base?.backgroundMode === "hdri" || base?.backgroundMode === "solid"
        ? base.backgroundMode
        : DEFAULT_VIEWER_ENVIRONMENT.backgroundMode,
    enabled: typeof base?.enabled === "boolean" ? base.enabled : DEFAULT_VIEWER_ENVIRONMENT.enabled
  };
}

const PLY_3DGS_PROPERTIES = [
  "x",
  "y",
  "z",
  "nx",
  "ny",
  "nz",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3"
] as const;

const TRANSFORM_STEP_OPTIONS = [0.1, 1, 10] as const;

const PLY_3DGS_RECORD_SIZE_BYTES = 68; // 17 float32 values
const SH_C0 = 0.28209479177387814;
const TWO_PI = Math.PI * 2;
const IDENTITY_TRANSFORM: MeshTransformRecord = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1]
};
const GROUND_ALIGN_OPTIONS: GroundAlignOptions = {
  upAxis: "y",
  gridSize: 0.35,
  bottomPercentile: 0.12,
  ransacThreshold: 0.03,
  ransacIterations: 220,
  useGridEnvelope: true,
  translateToGround: true,
  maxVertices: 120000,
  maxDebugPoints: 8000
};

interface ParsedPlyHeader {
  vertexCount: number;
  faceCount: number;
  dataOffset: number;
  format: string;
  properties: string[];
}

function objectToTransformRecord(object: THREE.Object3D): MeshTransformRecord {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
    scale: [object.scale.x, object.scale.y, object.scale.z]
  };
}

function applyTransformRecord(object: THREE.Object3D, transform: MeshTransformRecord) {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  object.quaternion.set(
    transform.rotation[0],
    transform.rotation[1],
    transform.rotation[2],
    transform.rotation[3]
  );
  object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
  object.updateMatrixWorld(true);
}

function isIdentityTransformRecord(transform: MeshTransformRecord | null | undefined) {
  if (!transform) return true;
  const [px, py, pz] = transform.position;
  const [qx, qy, qz, qw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const epsilon = 1e-6;
  return (
    Math.abs(px) <= epsilon &&
    Math.abs(py) <= epsilon &&
    Math.abs(pz) <= epsilon &&
    Math.abs(qx) <= epsilon &&
    Math.abs(qy) <= epsilon &&
    Math.abs(qz) <= epsilon &&
    Math.abs(qw - 1) <= epsilon &&
    Math.abs(sx - 1) <= epsilon &&
    Math.abs(sy - 1) <= epsilon &&
    Math.abs(sz - 1) <= epsilon
  );
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampRange(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function safeColorOrFallback(value: string, fallback: string): string {
  const normalized = value.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized) ? normalized : fallback;
}

function resolveToneMapping(mode: "ACESFilmic" | "Neutral" | "Reinhard" | "None"): THREE.ToneMapping {
  if (mode === "None") return THREE.NoToneMapping;
  if (mode === "Reinhard") return THREE.ReinhardToneMapping;
  if (mode === "Neutral" && typeof (THREE as unknown as { NeutralToneMapping?: THREE.ToneMapping }).NeutralToneMapping === "number") {
    return (THREE as unknown as { NeutralToneMapping: THREE.ToneMapping }).NeutralToneMapping;
  }
  return THREE.ACESFilmicToneMapping;
}

function getUrlPathnameLower(url: string): string {
  const [withoutHash] = url.split("#");
  const [withoutQuery] = withoutHash.split("?");
  return withoutQuery.toLowerCase();
}

function isLikelyExrUrl(url: string): boolean {
  return getUrlPathnameLower(url).endsWith(".exr");
}

function isLikelyHdrUrl(url: string): boolean {
  const normalized = getUrlPathnameLower(url);
  return normalized.endsWith(".hdr") || normalized.endsWith(".pic");
}

async function loadEnvironmentTexture(url: string): Promise<THREE.Texture> {
  interface ParsedEnvironmentTextureData {
    image?: THREE.DataTexture["image"];
    data?: THREE.DataTexture["image"]["data"];
    width?: number;
    height?: number;
    wrapS?: THREE.Wrapping;
    wrapT?: THREE.Wrapping;
    magFilter?: THREE.MagnificationTextureFilter;
    minFilter?: THREE.MinificationTextureFilter;
    anisotropy?: number;
    colorSpace?: THREE.ColorSpace;
    flipY?: boolean;
    format?: THREE.PixelFormat;
    type?: THREE.TextureDataType;
    mipmaps?: unknown[];
    mipmapCount?: number;
    generateMipmaps?: boolean;
  }

  const loadBuffer = async (): Promise<ArrayBuffer> => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  };

  const buildTextureFromParsedData = (parsed: ParsedEnvironmentTextureData): THREE.DataTexture => {
    const texture = new THREE.DataTexture();
    if (parsed.image && typeof parsed.image === "object" && !Array.isArray(parsed.image)) {
      texture.image = parsed.image;
    } else {
      const data = parsed.data;
      const width = Number(parsed.width);
      const height = Number(parsed.height);
      if (!data || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Environment map parser returned no image data.");
      }
      texture.image = { data, width, height };
    }

    texture.wrapS = typeof parsed.wrapS === "number" ? parsed.wrapS : THREE.ClampToEdgeWrapping;
    texture.wrapT = typeof parsed.wrapT === "number" ? parsed.wrapT : THREE.ClampToEdgeWrapping;
    texture.magFilter =
      typeof parsed.magFilter === "number" ? parsed.magFilter : THREE.LinearFilter;
    texture.minFilter =
      typeof parsed.minFilter === "number" ? parsed.minFilter : THREE.LinearFilter;
    texture.anisotropy = Number.isFinite(Number(parsed.anisotropy)) ? Number(parsed.anisotropy) : 1;
    if (typeof parsed.colorSpace === "string") {
      texture.colorSpace = parsed.colorSpace;
    }
    if (typeof parsed.flipY === "boolean") {
      texture.flipY = parsed.flipY;
    }
    if (typeof parsed.format === "number") {
      texture.format = parsed.format;
    }
    if (typeof parsed.type === "number") {
      texture.type = parsed.type;
    }
    if (Array.isArray(parsed.mipmaps)) {
      texture.mipmaps = parsed.mipmaps as unknown as typeof texture.mipmaps;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
    }
    if (Number(parsed.mipmapCount) === 1) {
      texture.minFilter = THREE.LinearFilter;
    }
    if (typeof parsed.generateMipmaps === "boolean") {
      texture.generateMipmaps = parsed.generateMipmaps;
    }
    texture.needsUpdate = true;
    return texture;
  };

  const loadExr = async () => {
    const buffer = await loadBuffer();
    const parsed = new EXRLoader().parse(buffer) as unknown as ParsedEnvironmentTextureData;
    return buildTextureFromParsedData(parsed);
  };
  const loadHdr = async () => {
    const buffer = await loadBuffer();
    const parsed = new RGBELoader().parse(buffer) as unknown as ParsedEnvironmentTextureData;
    return buildTextureFromParsedData(parsed);
  };
  const preferExr = isLikelyExrUrl(url);
  const preferHdr = isLikelyHdrUrl(url);
  if (preferExr) {
    try {
      return await loadExr();
    } catch {
      return loadHdr();
    }
  }
  if (preferHdr) {
    try {
      return await loadHdr();
    } catch {
      return loadExr();
    }
  }
  try {
    return await loadHdr();
  } catch {
    return loadExr();
  }
}

function normalizeRadiansSigned(value: number): number {
  let normalized = value % TWO_PI;
  if (normalized <= -Math.PI) normalized += TWO_PI;
  if (normalized > Math.PI) normalized -= TWO_PI;
  return normalized;
}

function unwrapRadiansNear(value: number, reference: number): number {
  let unwrapped = normalizeRadiansSigned(value);
  while (unwrapped - reference > Math.PI) {
    unwrapped -= TWO_PI;
  }
  while (unwrapped - reference < -Math.PI) {
    unwrapped += TWO_PI;
  }
  return unwrapped;
}

function stabilizeEulerXYZForDisplay(
  quaternion: THREE.Quaternion,
  previous: EulerTriplet | undefined
): EulerTriplet {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  const base: EulerTriplet = [euler.x, euler.y, euler.z];
  if (!previous) return base;

  const candidateBases: EulerTriplet[] = [
    base,
    [base[0] + Math.PI, Math.PI - base[1], base[2] + Math.PI],
    [base[0] - Math.PI, Math.PI - base[1], base[2] - Math.PI]
  ];

  let best = candidateBases[0] as EulerTriplet;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidateBases) {
    const stabilized: EulerTriplet = [
      unwrapRadiansNear(candidate[0], previous[0]),
      unwrapRadiansNear(candidate[1], previous[1]),
      unwrapRadiansNear(candidate[2], previous[2])
    ];
    const score =
      Math.abs(stabilized[0] - previous[0]) +
      Math.abs(stabilized[1] - previous[1]) +
      Math.abs(stabilized[2] - previous[2]);
    if (score < bestScore) {
      bestScore = score;
      best = stabilized;
    }
  }

  return best;
}

function parsePlyHeader(rawHeader: string): ParsedPlyHeader | null {
  const endMatch = rawHeader.match(/end_header(?:\r?\n|$)/);
  if (!endMatch || endMatch.index === undefined) {
    return null;
  }

  const headerSection = rawHeader.slice(0, endMatch.index + endMatch[0].length);
  const lines = headerSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0] !== "ply") return null;
  const formatLine = lines.find((line) => line.startsWith("format "));
  if (!formatLine) return null;
  const format = formatLine.replace(/^format\s+/, "").trim();

  const elementLine = lines.find((line) => /^element\s+vertex\s+\d+$/.test(line));
  if (!elementLine) return null;
  const vertexCount = Number(elementLine.split(/\s+/)[2]);
  if (!Number.isFinite(vertexCount) || vertexCount <= 0) return null;
  const faceElementLine = lines.find((line) => /^element\s+face\s+\d+$/.test(line));
  const faceCount = faceElementLine ? Number(faceElementLine.split(/\s+/)[2]) : 0;

  const parsedProperties = lines
    .filter((line) => line.startsWith("property "))
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : "";
    })
    .filter(Boolean);

  return {
    vertexCount,
    faceCount: Number.isFinite(faceCount) && faceCount > 0 ? faceCount : 0,
    dataOffset: endMatch.index + endMatch[0].length,
    format,
    properties: parsedProperties
  };
}

function parse3dgsHeader(rawHeader: string): { vertexCount: number; dataOffset: number } | null {
  const parsed = parsePlyHeader(rawHeader);
  if (!parsed) return null;
  if (parsed.format !== "binary_little_endian 1.0") return null;
  if (parsed.faceCount > 0) return null;

  const expectedProperties = PLY_3DGS_PROPERTIES.map((name) => `float:${name}`);
  if (parsed.properties.length !== expectedProperties.length) return null;
  for (let i = 0; i < expectedProperties.length; i += 1) {
    if (parsed.properties[i] !== expectedProperties[i]) return null;
  }

  return { vertexCount: parsed.vertexCount, dataOffset: parsed.dataOffset };
}

async function inspectPlyUrl(
  url: string
): Promise<{ vertexCount: number; faceCount: number; hasFaces: boolean; is3dgs: boolean } | null> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Range: "bytes=0-65535" }
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headerRaw = new TextDecoder("utf-8").decode(bytes);
    const parsed = parsePlyHeader(headerRaw);
    if (!parsed) return null;
    const expectedProperties = PLY_3DGS_PROPERTIES.map((name) => `float:${name}`);
    const is3dgs =
      parsed.format === "binary_little_endian 1.0" &&
      parsed.properties.length === expectedProperties.length &&
      expectedProperties.every((prop, idx) => parsed.properties[idx] === prop);
    const faceCount = parsed.faceCount;
    const hasFaces = faceCount > 0;
    return { vertexCount: parsed.vertexCount, faceCount, hasFaces, is3dgs };
  } catch {
    return null;
  }
}

async function compute3dgsBoundsFromUrl(url: string): Promise<THREE.Box3 | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const maxHeaderBytes = Math.min(bytes.byteLength, 256 * 1024);
    const headerRaw = new TextDecoder("utf-8").decode(bytes.subarray(0, maxHeaderBytes));
    const parsedHeader = parse3dgsHeader(headerRaw);
    if (!parsedHeader) return null;

    const requiredBytes = parsedHeader.dataOffset + parsedHeader.vertexCount * PLY_3DGS_RECORD_SIZE_BYTES;
    if (requiredBytes > arrayBuffer.byteLength) {
      return null;
    }

    const dataView = new DataView(arrayBuffer, parsedHeader.dataOffset);
    const min = new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (let i = 0; i < parsedHeader.vertexCount; i += 1) {
      const base = i * PLY_3DGS_RECORD_SIZE_BYTES;
      const x = dataView.getFloat32(base + 0, true);
      const y = dataView.getFloat32(base + 4, true);
      const z = dataView.getFloat32(base + 8, true);
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    }
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return null;
    return new THREE.Box3(min, max);
  } catch {
    return null;
  }
}

async function sample3dgsPointsFromUrl(url: string, maxPoints = 60000): Promise<THREE.Vector3[]> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return [];
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const maxHeaderBytes = Math.min(bytes.byteLength, 256 * 1024);
    const headerRaw = new TextDecoder("utf-8").decode(bytes.subarray(0, maxHeaderBytes));
    const parsedHeader = parse3dgsHeader(headerRaw);
    if (!parsedHeader) return [];

    const requiredBytes = parsedHeader.dataOffset + parsedHeader.vertexCount * PLY_3DGS_RECORD_SIZE_BYTES;
    if (requiredBytes > arrayBuffer.byteLength) {
      return [];
    }

    const safeMax = Math.max(1000, Math.floor(maxPoints));
    const stride = Math.max(1, Math.ceil(parsedHeader.vertexCount / safeMax));
    const dataView = new DataView(arrayBuffer, parsedHeader.dataOffset);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < parsedHeader.vertexCount; i += stride) {
      const base = i * PLY_3DGS_RECORD_SIZE_BYTES;
      const x = dataView.getFloat32(base + 0, true);
      const y = dataView.getFloat32(base + 4, true);
      const z = dataView.getFloat32(base + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      points.push(new THREE.Vector3(x, y, z));
    }
    return points;
  } catch {
    return [];
  }
}

async function tryLoad3dgsBinaryPlyGeometry(url: string): Promise<THREE.BufferGeometry | null> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PLY: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const maxHeaderBytes = Math.min(bytes.byteLength, 256 * 1024);
  const headerRaw = new TextDecoder("utf-8").decode(bytes.subarray(0, maxHeaderBytes));
  const parsedHeader = parse3dgsHeader(headerRaw);
  if (!parsedHeader) {
    return null;
  }

  const requiredBytes = parsedHeader.dataOffset + parsedHeader.vertexCount * PLY_3DGS_RECORD_SIZE_BYTES;
  if (requiredBytes > arrayBuffer.byteLength) {
    throw new Error("PLY file is truncated for expected 3DGS binary schema.");
  }

  const dataView = new DataView(arrayBuffer, parsedHeader.dataOffset);
  const vertexCount = parsedHeader.vertexCount;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i += 1) {
    const base = i * PLY_3DGS_RECORD_SIZE_BYTES;
    const x = dataView.getFloat32(base + 0, true);
    const y = dataView.getFloat32(base + 4, true);
    const z = dataView.getFloat32(base + 8, true);
    const fdc0 = dataView.getFloat32(base + 24, true);
    const fdc1 = dataView.getFloat32(base + 28, true);
    const fdc2 = dataView.getFloat32(base + 32, true);
    const opacityLogit = dataView.getFloat32(base + 36, true);
    void opacityLogit;

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // GraphDECO SH-DC -> RGB: rgb = 0.5 + C0 * f_dc
    const r = clamp01(0.5 + SH_C0 * fdc0);
    const g = clamp01(0.5 + SH_C0 * fdc1);
    const b = clamp01(0.5 + SH_C0 * fdc2);

    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function hashU32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

function replaceVertexCountInPlyHeader(rawHeader: string, nextVertexCount: number): string {
  return rawHeader.replace(/element\s+vertex\s+\d+/m, `element vertex ${nextVertexCount}`);
}

async function buildDownsampled3dgsPlyBlob(
  sourceUrl: string,
  keepFraction: number
): Promise<{ blobUrl: string; keptVertices: number; sourceVertices: number } | null> {
  const response = await fetch(sourceUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to download PLY: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const maxHeaderBytes = Math.min(bytes.byteLength, 256 * 1024);
  const headerRaw = new TextDecoder("utf-8").decode(bytes.subarray(0, maxHeaderBytes));
  const parsedHeader = parse3dgsHeader(headerRaw);
  if (!parsedHeader) return null;

  const sourceVertices = parsedHeader.vertexCount;
  if (sourceVertices <= 0) return null;

  if (keepFraction >= 0.9999) {
    return {
      blobUrl: URL.createObjectURL(new Blob([arrayBuffer], { type: "application/octet-stream" })),
      keptVertices: sourceVertices,
      sourceVertices
    };
  }

  const dataStart = parsedHeader.dataOffset;
  const sourceData = bytes.subarray(dataStart);
  const requiredBytes = sourceVertices * PLY_3DGS_RECORD_SIZE_BYTES;
  if (sourceData.byteLength < requiredBytes) {
    throw new Error("PLY payload is truncated for expected 3DGS vertex count.");
  }

  const threshold = Math.max(1, Math.min(0xffffffff, Math.floor(keepFraction * 0xffffffff)));
  let keptVertices = 0;
  for (let i = 0; i < sourceVertices; i += 1) {
    if (hashU32(i) <= threshold) keptVertices += 1;
  }
  if (keptVertices <= 0) keptVertices = 1;

  const baseHeaderEnd = headerRaw.match(/end_header(?:\r?\n|$)/);
  if (!baseHeaderEnd || baseHeaderEnd.index === undefined) {
    throw new Error("Invalid PLY header.");
  }
  const originalHeader = headerRaw.slice(0, baseHeaderEnd.index + baseHeaderEnd[0].length);
  const nextHeaderText = replaceVertexCountInPlyHeader(originalHeader, keptVertices);
  const nextHeaderBytes = new TextEncoder().encode(nextHeaderText);
  const out = new Uint8Array(nextHeaderBytes.byteLength + keptVertices * PLY_3DGS_RECORD_SIZE_BYTES);
  out.set(nextHeaderBytes, 0);
  let writeOffset = nextHeaderBytes.byteLength;

  for (let i = 0; i < sourceVertices; i += 1) {
    if (hashU32(i) > threshold) continue;
    const recordStart = i * PLY_3DGS_RECORD_SIZE_BYTES;
    const recordEnd = recordStart + PLY_3DGS_RECORD_SIZE_BYTES;
    out.set(sourceData.subarray(recordStart, recordEnd), writeOffset);
    writeOffset += PLY_3DGS_RECORD_SIZE_BYTES;
  }

  const blobUrl = URL.createObjectURL(new Blob([out], { type: "application/octet-stream" }));
  return { blobUrl, keptVertices, sourceVertices };
}

function normalizeMeshUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    const keyParam = parsed.searchParams.get("key");
    if (parsed.pathname === "/api/storage/object" && keyParam) {
      return `storage:${keyParam}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function urlHasPlyExtension(url: string): boolean {
  try {
    const parsed = new URL(url, "http://localhost");
    const keyParam = parsed.searchParams.get("key");
    const source = (keyParam && keyParam.length > 0 ? keyParam : parsed.pathname).toLowerCase();
    return source.endsWith(".ply") || source.endsWith(".compressed.ply");
  } catch {
    const lower = url.toLowerCase();
    return lower.endsWith(".ply") || lower.endsWith(".compressed.ply");
  }
}

function buildObjectItemKey(kind: SelectableSceneObjectKind, id: string) {
  return `${kind}:${id}`;
}

function parseObjectItemKey(key: string): { kind: SelectableSceneObjectKind; id: string } | null {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex < 0) return null;
  const kindRaw = key.slice(0, separatorIndex);
  const id = key.slice(separatorIndex + 1);
  if (kindRaw !== "mesh" && kindRaw !== "splat") return null;
  return { kind: kindRaw, id };
}

function computeUnionBoundsForObjects(objects: THREE.Object3D[]): THREE.Box3 | null {
  const union = new THREE.Box3();
  const current = new THREE.Box3();
  let hasAny = false;
  for (const object of objects) {
    current.setFromObject(object);
    if (current.isEmpty()) continue;
    if (!hasAny) {
      union.copy(current);
      hasAny = true;
    } else {
      union.union(current);
    }
  }
  return hasAny ? union : null;
}

async function getGaussianSplatsModule() {
  return import("@mkkellogg/gaussian-splats-3d");
}

let sparkModulePromise: Promise<Record<string, unknown>> | null = null;

async function importSparkModuleDynamic() {
  return import("@sparkjsdev/spark");
}

async function getSparkModule() {
  if (!sparkModulePromise) {
    sparkModulePromise = importSparkModuleDynamic().then((module) => module as Record<string, unknown>);
  }
  return sparkModulePromise;
}

function getRuntimeOrderForPreference(preference: "auto" | "spark" | "legacy"): SplatRuntimeName[] {
  const sparkEnabled = isSparkRuntimeEnabled();
  if (!sparkEnabled) return ["legacy"];
  if (preference === "legacy") return ["legacy"];
  if (preference === "spark") return ["spark", "legacy"];
  return ["spark", "legacy"];
}

async function waitForSparkSplatReady(instance: Record<string, unknown>) {
  const promiseCandidates = [
    instance.initializedPromise,
    instance.readyPromise,
    instance.loadPromise
  ] as Array<unknown>;
  for (const candidate of promiseCandidates) {
    if (candidate && typeof (candidate as Promise<unknown>).then === "function") {
      await candidate;
      return;
    }
  }
  if (typeof instance.waitUntilReady === "function") {
    await (instance.waitUntilReady as () => Promise<void>)();
    return;
  }
  if (typeof instance.initialize === "function") {
    await (instance.initialize as () => Promise<void>)();
    return;
  }
  if (typeof instance.load === "function") {
    await (instance.load as () => Promise<void>)();
  }
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      mesh.geometry.dispose();
    }

    const materialValue = mesh.material;
    const materials = Array.isArray(materialValue) ? materialValue : materialValue ? [materialValue] : [];
    for (const material of materials) {
      const record = material as unknown as Record<string, unknown>;
      for (const value of Object.values(record)) {
        if (value && typeof value === "object" && "isTexture" in value) {
          (value as THREE.Texture).dispose();
        }
      }
      material.dispose();
    }
  });
}

export function UnifiedWorldViewer({
  manifest,
  externalSceneAdditions = [],
  fileMenu
}: {
  manifest: WorldManifest;
  externalSceneAdditions?: ExternalSceneAddition[];
  fileMenu?: ViewerFileMenu | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitRef = useRef<InstanceType<typeof OrbitControls> | null>(null);
  const selectedRef = useRef<THREE.Object3D | null>(null);
  const selectedBoxRef = useRef<THREE.Object3D | null>(null);
  const requestRef = useRef<number | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const alignmentRootRef = useRef<THREE.Group | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const outlinePassRef = useRef<OutlinePass | null>(null);
  const transformControlsRef = useRef<InstanceType<typeof TransformControls> | null>(null);
  const transformDraggingRef = useRef(false);
  const transformModeRef = useRef<TransformMode>("translate");
  const transformSpaceRef = useRef<TransformSpace>("world");
  const fitSelectionRef = useRef<() => void>(() => {});
  const meshRootsRef = useRef<THREE.Object3D[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAlignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const keysRef = useRef<Set<string>>(new Set());
  const splatHandlesRef = useRef(new Set<SplatHandle>());
  const tempBlobUrlsRef = useRef<string[]>([]);
  const hudRef = useRef<ViewerHudStats>(DEFAULT_STATS);
  const fpsCounterRef = useRef({ acc: 0, frames: 0, fps: 0 });
  const pausedRef = useRef(false);
  const navModeRef = useRef<NavigationMode>("orbit");
  const viewModeRef = useRef<ViewMode>("default");
  const selectedKindRef = useRef<SceneObjectKind | null>(null);
  const modelviewerAutoRotateRef = useRef(false);
  const showGridRef = useRef(true);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const flySpeedRef = useRef(4);
  const rotationDisplayRef = useRef<Map<string, EulerTriplet>>(new Map());
  const removedMeshIdsRef = useRef<Set<string>>(new Set());
  const removedSplatSourceKeysRef = useRef<Set<string>>(new Set());
  const objectContextMenuRef = useRef<HTMLDivElement | null>(null);
  const artifactContextMenuRef = useRef<HTMLDivElement | null>(null);
  const autoAlignOnLoadRef = useRef(false);
  const groundAlignDebugGroupRef = useRef<THREE.Group | null>(null);
  const splatSupportSampleCacheRef = useRef<Map<string, THREE.Vector3[]>>(new Map());
  const activeGroupRef = useRef<ActiveObjectGroup | null>(null);
  const groupCounterRef = useRef(1);
  const objectListSelectionAnchorRef = useRef<string | null>(null);
  const loadedExternalAdditionIdsRef = useRef<Set<string>>(new Set());
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const directionalLightRef = useRef<THREE.DirectionalLight | null>(null);
  const pmremGeneratorRef = useRef<THREE.PMREMGenerator | null>(null);
  const hdriSourceTextureRef = useRef<THREE.Texture | null>(null);
  const hdriPmremTargetRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const environmentApplyTokenRef = useRef(0);
  const hdriLocalObjectUrlRef = useRef<string | null>(null);
  const hdriFileInputRef = useRef<HTMLInputElement | null>(null);

  const [navMode, setNavMode] = useState<NavigationMode>("orbit");
  const [viewMode, setViewMode] = useState<ViewMode>("default");
  const [modelviewerAutoRotate, setModelviewerAutoRotate] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [flySpeed, setFlySpeed] = useState([4]);
  const [splatLoadProfile, setSplatLoadProfile] = useState<SplatLoadProfile>("full");
  const [splatDensityDraft, setSplatDensityDraft] = useState([100]);
  const [splatDensityApplied, setSplatDensityApplied] = useState(100);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [transformSpace, setTransformSpace] = useState<TransformSpace>("world");
  const [hud, setHud] = useState(DEFAULT_STATS);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<SceneObjectKind | null>(null);
  const [meshItems, setMeshItems] = useState<MeshListItem[]>([]);
  const [splatItems, setSplatItems] = useState<SplatListItem[]>([]);
  const [transformDraft, setTransformDraft] = useState<TransformDraft | null>(null);
  const [transformStep, setTransformStep] = useState<number>(1);
  const [transformDebug, setTransformDebug] = useState<string>("");
  const [persistState, setPersistState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [persistMessage, setPersistMessage] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<FloatingPanel>("none");
  const [activeSplatRuntimes, setActiveSplatRuntimes] = useState<LoadedSplatRuntime[]>([]);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [removedMeshIds, setRemovedMeshIds] = useState<string[]>([]);
  const [removedSplatSourceKeys, setRemovedSplatSourceKeys] = useState<string[]>([]);
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | null>(null);
  const [artifactContextMenu, setArtifactContextMenu] = useState<ArtifactContextMenuState | null>(null);
  const [groundAlignDebug, setGroundAlignDebug] = useState(false);
  const [groupSelectionKeys, setGroupSelectionKeys] = useState<string[]>([]);
  const [activeGroupMeta, setActiveGroupMeta] = useState<{
    id: string;
    name: string;
    memberCount: number;
  } | null>(null);
  const [dragSelectionRect, setDragSelectionRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [viewerEnvironment, setViewerEnvironment] = useState<ViewerEnvironmentConfig>(() =>
    normalizeEnvironmentConfig(manifest.environment)
  );
  const [hdriUrlDraft, setHdriUrlDraft] = useState<string>(() => normalizeEnvironmentConfig(manifest.environment).hdriUrl ?? "");

  const preferredRuntimeOrder = useMemo(
    () => getRuntimeOrderForPreference(getSplatRuntimePreference()),
    []
  );

  const directSplats = useMemo(
    () =>
      (manifest.splats ?? [])
        .filter((entry) => typeof entry.sourceUrl === "string" && entry.sourceUrl.length > 0)
        .map((entry) => ({
          url: entry.sourceUrl as string,
          formatHint: entry.formatHint ?? null
        })),
    [manifest.splats]
  );

  const objectItems = useMemo(
    () => [
      ...meshItems.map((item) => ({
        id: item.id,
        label: item.label,
        kind: "mesh" as const
      })),
      ...splatItems.map((item) => ({
        id: item.id,
        label: item.label,
        kind: "splat" as const,
        splatCount: item.splatCount
      }))
    ],
    [meshItems, splatItems]
  );

  const groupSelectionSet = useMemo(() => new Set(groupSelectionKeys), [groupSelectionKeys]);
  const orderedObjectKeys = useMemo(
    () => objectItems.map((item) => buildObjectItemKey(item.kind, item.id)),
    [objectItems]
  );

  const resolveObjectByKindAndId = useCallback(
    (kind: SelectableSceneObjectKind, id: string): THREE.Object3D | null => {
      if (kind === "mesh") {
        return meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === id) ?? null;
      }
      return [...splatHandlesRef.current].find((entry) => entry.id === id)?.object ?? null;
    },
    []
  );

  const resolveObjectByKey = useCallback(
    (key: string): ActiveGroupMember | null => {
      const parsedKey = parseObjectItemKey(key);
      if (!parsedKey) return null;
      const { kind, id } = parsedKey;
      const object = resolveObjectByKindAndId(kind, id);
      if (!object) return null;
      const item = objectItems.find((entry) => entry.kind === kind && entry.id === id);
      return {
        key,
        kind,
        id,
        label: item?.label ?? object.name ?? id,
        object,
        baselineLocal: objectToTransformRecord(object)
      };
    },
    [objectItems, resolveObjectByKindAndId]
  );

  const hasActiveSelection = Boolean(selectedKind);

  const markedGroupMembers = useMemo(
    () =>
      groupSelectionKeys
        .map((key) => resolveObjectByKey(key))
        .filter((value): value is ActiveGroupMember => Boolean(value?.object?.parent)),
    [groupSelectionKeys, resolveObjectByKey]
  );

  const canCreateGroup = markedGroupMembers.length >= 2;
  const canSelectExistingGroup = Boolean(activeGroupMeta && activeGroupMeta.memberCount >= 2);
  const canAutoAlignSelected = selectedKind === "mesh" || selectedKind === "splat";

  const selectObjectRangeFromAnchor = useCallback(
    (targetKey: string) => {
      const targetIndex = orderedObjectKeys.indexOf(targetKey);
      if (targetIndex < 0) return;
      const anchorKey = objectListSelectionAnchorRef.current;
      const anchorIndex = anchorKey ? orderedObjectKeys.indexOf(anchorKey) : -1;
      const start = anchorIndex >= 0 ? Math.min(anchorIndex, targetIndex) : targetIndex;
      const end = anchorIndex >= 0 ? Math.max(anchorIndex, targetIndex) : targetIndex;
      const rangeKeys = orderedObjectKeys.slice(start, end + 1);
      setGroupSelectionKeys((current) => [...new Set([...current, ...rangeKeys])]);
      objectListSelectionAnchorRef.current = targetKey;
    },
    [orderedObjectKeys]
  );

  const configuredRuntimeLabel = useMemo(() => {
    if (preferredRuntimeOrder.length === 0) return "legacy";
    return preferredRuntimeOrder.join(" -> ");
  }, [preferredRuntimeOrder]);

  const activeRuntimeLabel = useMemo(() => {
    if (activeSplatRuntimes.length === 0) return "none";
    return activeSplatRuntimes.join(", ");
  }, [activeSplatRuntimes]);

  const isPersistableArtifact = Boolean(
    typeof manifest.artifactId === "string" &&
      manifest.artifactId.length > 0 &&
      !manifest.artifactId.startsWith("local-")
  );

  const applyTransformMode = useCallback((mode: TransformMode) => {
    setTransformMode(mode);
    transformModeRef.current = mode;
    transformControlsRef.current?.setMode(mode);
  }, []);

  const applyTransformSpace = useCallback((space: TransformSpace) => {
    setTransformSpace(space);
    transformSpaceRef.current = space;
    transformControlsRef.current?.setSpace(space);
  }, []);

  const toggleTransformSpace = useCallback(() => {
    const nextSpace: TransformSpace = transformSpaceRef.current === "world" ? "local" : "world";
    applyTransformSpace(nextSpace);
  }, [applyTransformSpace]);

  const disposeActiveHdriResources = useCallback(() => {
    if (hdriPmremTargetRef.current) {
      hdriPmremTargetRef.current.dispose();
      hdriPmremTargetRef.current = null;
    }
    if (hdriSourceTextureRef.current) {
      hdriSourceTextureRef.current.dispose();
      hdriSourceTextureRef.current = null;
    }
  }, []);

  const revokeLocalHdriUrl = useCallback(() => {
    if (!hdriLocalObjectUrlRef.current) return;
    URL.revokeObjectURL(hdriLocalObjectUrlRef.current);
    hdriLocalObjectUrlRef.current = null;
  }, []);

  const applyViewerEnvironment = useCallback(
    async (config: ViewerEnvironmentConfig) => {
      const scene = sceneRef.current;
      const renderer = rendererRef.current;
      if (!scene || !renderer) return;

      const sceneWithEnvironment = scene as THREE.Scene & {
        backgroundBlurriness?: number;
        backgroundIntensity?: number;
        backgroundRotation?: THREE.Euler;
        environmentIntensity?: number;
        environmentRotation?: THREE.Euler;
      };
      renderer.toneMapping = resolveToneMapping(config.toneMapping);
      renderer.toneMappingExposure = config.exposure;
      sceneWithEnvironment.environmentIntensity = config.envIntensity;
      sceneWithEnvironment.backgroundIntensity = config.envIntensity;
      sceneWithEnvironment.backgroundBlurriness = config.hdriBlur;

      if (hemiLightRef.current) {
        hemiLightRef.current.color.set(config.sunColor);
        hemiLightRef.current.groundColor.set(config.groundColor);
        hemiLightRef.current.intensity = config.ambientIntensity;
      }
      if (directionalLightRef.current) {
        directionalLightRef.current.color.set(config.sunColor);
        directionalLightRef.current.intensity = config.sunIntensity;
      }

      const applyBackgroundMode = () => {
        if (config.backgroundMode === "transparent") {
          scene.background = null;
          return;
        }
        if (config.backgroundMode === "solid") {
          scene.background = new THREE.Color(config.backgroundColor);
        }
      };

      const token = ++environmentApplyTokenRef.current;
      sceneWithEnvironment.environmentRotation = new THREE.Euler(0, 0, 0);
      sceneWithEnvironment.backgroundRotation = new THREE.Euler(0, 0, 0);
      disposeActiveHdriResources();

      if (!config.enabled || !config.hdriUrl) {
        scene.environment = null;
        applyBackgroundMode();
        return;
      }

      try {
        const texture = await loadEnvironmentTexture(config.hdriUrl);
        if (token !== environmentApplyTokenRef.current) {
          texture.dispose();
          return;
        }

        texture.mapping = THREE.EquirectangularReflectionMapping;
        hdriSourceTextureRef.current = texture;
        if (!pmremGeneratorRef.current) {
          pmremGeneratorRef.current = new THREE.PMREMGenerator(renderer);
          pmremGeneratorRef.current.compileEquirectangularShader();
        }
        const pmremTarget = pmremGeneratorRef.current.fromEquirectangular(texture);
        hdriPmremTargetRef.current = pmremTarget;
        scene.environment = pmremTarget.texture;
        const rotationY = THREE.MathUtils.degToRad(config.hdriRotationY);
        sceneWithEnvironment.environmentRotation = new THREE.Euler(0, rotationY, 0);
        if (config.backgroundMode === "hdri") {
          scene.background = texture;
          sceneWithEnvironment.backgroundRotation = new THREE.Euler(0, rotationY, 0);
        } else {
          applyBackgroundMode();
        }
        setRuntimeNotice(null);
      } catch (hdriError) {
        if (token !== environmentApplyTokenRef.current) return;
        const message = hdriError instanceof Error ? hdriError.message : "Unable to load HDR/EXR environment.";
        setRuntimeNotice(`Environment map load failed. Falling back to solid background. (${message})`);
        scene.environment = null;
        applyBackgroundMode();
      }
    },
    [disposeActiveHdriResources]
  );

  const applyHdriUrlDraft = useCallback(() => {
    const trimmed = hdriUrlDraft.trim();
    setViewerEnvironment((current) =>
      normalizeEnvironmentConfig({
        ...current,
        enabled: true,
        hdriUrl: trimmed.length > 0 ? trimmed : null
      })
    );
  }, [hdriUrlDraft]);

  const clearHdriEnvironment = useCallback(() => {
    revokeLocalHdriUrl();
    setHdriUrlDraft("");
    setViewerEnvironment((current) =>
      normalizeEnvironmentConfig({
        ...current,
        hdriUrl: null,
        backgroundMode: current.backgroundMode === "hdri" ? "solid" : current.backgroundMode
      })
    );
  }, [revokeLocalHdriUrl]);

  const pickLocalHdri = useCallback(() => {
    hdriFileInputRef.current?.click();
  }, []);

  const onHdriFilePicked = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      revokeLocalHdriUrl();
      const objectUrl = URL.createObjectURL(file);
      hdriLocalObjectUrlRef.current = objectUrl;
      setHdriUrlDraft(objectUrl);
      setViewerEnvironment((current) =>
        normalizeEnvironmentConfig({
          ...current,
          enabled: true,
          hdriUrl: objectUrl
        })
      );
      setRuntimeNotice(`Loaded local HDRI: ${file.name}`);
      event.currentTarget.value = "";
    },
    [revokeLocalHdriUrl]
  );

  useEffect(() => {
    const normalized = normalizeEnvironmentConfig(manifest.environment);
    environmentApplyTokenRef.current += 1;
    revokeLocalHdriUrl();
    setViewerEnvironment(normalized);
    setHdriUrlDraft(normalized.hdriUrl ?? "");
  }, [manifest.artifactId, manifest.environment, revokeLocalHdriUrl]);

  useEffect(() => {
    void applyViewerEnvironment(viewerEnvironment);
  }, [applyViewerEnvironment, viewerEnvironment]);

  useEffect(() => {
    return () => {
      revokeLocalHdriUrl();
    };
  }, [revokeLocalHdriUrl]);

  useEffect(() => {
    navModeRef.current = navMode;
  }, [navMode]);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    transformModeRef.current = transformMode;
    transformControlsRef.current?.setMode(transformMode);
  }, [transformMode]);

  useEffect(() => {
    transformSpaceRef.current = transformSpace;
    transformControlsRef.current?.setSpace(transformSpace);
  }, [transformSpace]);

  useEffect(() => {
    selectedKindRef.current = selectedKind;
  }, [selectedKind]);

  useEffect(() => {
    modelviewerAutoRotateRef.current = modelviewerAutoRotate;
  }, [modelviewerAutoRotate]);

  useEffect(() => {
    showGridRef.current = showGrid;
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
    }
  }, [showGrid]);

  useEffect(() => {
    flySpeedRef.current = flySpeed[0] ?? 4;
  }, [flySpeed]);

  useEffect(() => {
    removedMeshIdsRef.current = new Set(removedMeshIds);
  }, [removedMeshIds]);

  useEffect(() => {
    removedSplatSourceKeysRef.current = new Set(removedSplatSourceKeys);
  }, [removedSplatSourceKeys]);

  useEffect(() => {
    if (openPanel === "objects") return;
    setObjectContextMenu(null);
  }, [openPanel]);

  useEffect(() => {
    if (openPanel === "file") return;
    setArtifactContextMenu(null);
  }, [openPanel]);

  useEffect(() => {
    if (!objectContextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && objectContextMenuRef.current?.contains(target)) return;
      setObjectContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setObjectContextMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [objectContextMenu]);

  useEffect(() => {
    if (!artifactContextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && artifactContextMenuRef.current?.contains(target)) return;
      setArtifactContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArtifactContextMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [artifactContextMenu]);

  useEffect(() => {
    setGroupSelectionKeys((current) =>
      current.filter((key) => {
        const member = resolveObjectByKey(key);
        return Boolean(member?.object.parent);
      })
    );
  }, [objectItems, resolveObjectByKey]);

  useEffect(() => {
    const anchor = objectListSelectionAnchorRef.current;
    if (anchor && !orderedObjectKeys.includes(anchor)) {
      objectListSelectionAnchorRef.current = null;
    }
  }, [orderedObjectKeys]);

  const updateHudFromHandles = useCallback(() => {
    let loadedSplats = 0;
    for (const handle of splatHandlesRef.current) {
      loadedSplats += handle.splatCount ?? 0;
    }
    hudRef.current = {
      ...DEFAULT_STATS,
      loadedSplats,
      loadedMB: (loadedSplats * PLY_3DGS_RECORD_SIZE_BYTES) / (1024 * 1024)
    };
  }, []);

  const refreshMeshItems = useCallback(() => {
    const byId = new Map<string, MeshListItem>();
    meshRootsRef.current.forEach((meshRoot, index) => {
      const id = meshRoot.name || meshRoot.uuid;
      if (byId.has(id)) return;
      byId.set(id, {
        id,
        label: meshRoot.name || `Mesh ${index + 1}`
      });
    });
    setMeshItems([...byId.values()]);
  }, []);

  const refreshSplatItems = useCallback(() => {
    const next: SplatListItem[] = [];
    const runtimeSet = new Set<LoadedSplatRuntime>();
    for (const handle of splatHandlesRef.current) {
      runtimeSet.add(handle.runtime);
      next.push({
        id: handle.id,
        label: handle.label,
        splatCount: handle.splatCount ?? 0
      });
    }
    setSplatItems(next);
    setActiveSplatRuntimes([...runtimeSet.values()]);
  }, []);

  const syncTransformDraft = useCallback((object: THREE.Object3D | null) => {
    if (!object) {
      setTransformDraft(null);
      setTransformDebug("No object selected");
      return;
    }
    const rotationKey = object.uuid;
    const previousEuler = rotationDisplayRef.current.get(rotationKey);
    const stabilizedEuler = stabilizeEulerXYZForDisplay(object.quaternion, previousEuler);
    rotationDisplayRef.current.set(rotationKey, stabilizedEuler);
    const world = new THREE.Vector3();
    object.getWorldPosition(world);
    setTransformDraft({
      position: [
        object.position.x.toFixed(3),
        object.position.y.toFixed(3),
        object.position.z.toFixed(3)
      ],
      rotation: [
        THREE.MathUtils.radToDeg(stabilizedEuler[0]).toFixed(2),
        THREE.MathUtils.radToDeg(stabilizedEuler[1]).toFixed(2),
        THREE.MathUtils.radToDeg(stabilizedEuler[2]).toFixed(2)
      ],
      scale: [object.scale.x.toFixed(3), object.scale.y.toFixed(3), object.scale.z.toFixed(3)]
    });
    setTransformDebug(
      `selected=${object.name || object.uuid} local=(${object.position.x.toFixed(3)}, ${object.position.y.toFixed(
        3
      )}, ${object.position.z.toFixed(3)}) world=(${world.x.toFixed(3)}, ${world.y.toFixed(3)}, ${world.z.toFixed(3)})`
    );
  }, []);

  const syncTransformDraftFromGroup = useCallback((group: ActiveObjectGroup | null) => {
    if (!group) {
      setTransformDraft(null);
      setTransformDebug("No object selected");
      return;
    }
    const rotationKey = group.id;
    const previousEuler = rotationDisplayRef.current.get(rotationKey);
    const stabilizedEuler = stabilizeEulerXYZForDisplay(group.quaternion, previousEuler);
    rotationDisplayRef.current.set(rotationKey, stabilizedEuler);
    const world = group.position
      .clone()
      .applyMatrix4(alignmentRootRef.current?.matrixWorld ?? new THREE.Matrix4());
    setTransformDraft({
      position: [
        group.position.x.toFixed(3),
        group.position.y.toFixed(3),
        group.position.z.toFixed(3)
      ],
      rotation: [
        THREE.MathUtils.radToDeg(stabilizedEuler[0]).toFixed(2),
        THREE.MathUtils.radToDeg(stabilizedEuler[1]).toFixed(2),
        THREE.MathUtils.radToDeg(stabilizedEuler[2]).toFixed(2)
      ],
      scale: [group.scale.x.toFixed(3), group.scale.y.toFixed(3), group.scale.z.toFixed(3)]
    });
    setTransformDebug(
      `selected=${group.name} members=${group.members.length} local=(${group.position.x.toFixed(3)}, ${group.position.y.toFixed(3)}, ${group.position.z.toFixed(3)}) world=(${world.x.toFixed(3)}, ${world.y.toFixed(3)}, ${world.z.toFixed(3)})`
    );
  }, []);

  const syncTransformDraftForCurrentSelection = useCallback(() => {
    const currentKind = selectedKindRef.current;
    if (currentKind === "group") {
      syncTransformDraftFromGroup(activeGroupRef.current);
      return;
    }
    syncTransformDraft(selectedRef.current);
  }, [syncTransformDraft, syncTransformDraftFromGroup]);

  const serializeMeshTransforms = useCallback((): Record<string, MeshTransformRecord> => {
    const transforms: Record<string, MeshTransformRecord> = {};
    for (const meshRoot of meshRootsRef.current) {
      const id = meshRoot.name || meshRoot.uuid;
      transforms[id] = objectToTransformRecord(meshRoot);
    }
    return transforms;
  }, []);

  const serializeSplatTransforms = useCallback((): Record<string, MeshTransformRecord> => {
    const transforms: Record<string, MeshTransformRecord> = {};
    for (const handle of splatHandlesRef.current) {
      transforms[handle.id] = objectToTransformRecord(handle.object);
    }
    return transforms;
  }, []);

  const applyMeshTransforms = useCallback((transforms: Record<string, MeshTransformRecord>) => {
    for (const meshRoot of meshRootsRef.current) {
      const id = meshRoot.name || meshRoot.uuid;
      const transform = transforms[id];
      if (!transform) continue;
      applyTransformRecord(meshRoot, transform);
    }
  }, []);

  const serializeSceneAlignment = useCallback((): MeshTransformRecord | null => {
    const alignmentRoot = alignmentRootRef.current;
    if (!alignmentRoot) return null;
    return objectToTransformRecord(alignmentRoot);
  }, []);

  const applyPersistedSceneAlignment = useCallback((transform: MeshTransformRecord | null) => {
    const alignmentRoot = alignmentRootRef.current;
    if (!alignmentRoot) return;
    applyTransformRecord(alignmentRoot, transform ?? IDENTITY_TRANSFORM);
    sceneRef.current?.updateMatrixWorld(true);
  }, []);

  const clearGroundAlignDebug = useCallback(() => {
    const existing = groundAlignDebugGroupRef.current;
    if (!existing) return;
    existing.parent?.remove(existing);
    existing.traverse((child) => {
      const withGeometry = child as THREE.Object3D & { geometry?: THREE.BufferGeometry };
      withGeometry.geometry?.dispose?.();
      const withMaterial = child as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
      if (Array.isArray(withMaterial.material)) {
        withMaterial.material.forEach((material) => material.dispose?.());
      } else {
        withMaterial.material?.dispose?.();
      }
    });
    groundAlignDebugGroupRef.current = null;
  }, []);

  const persistTransforms = useCallback(async () => {
    if (!isPersistableArtifact || !manifest.artifactId) return;
    try {
      setPersistState("saving");
      const response = await fetch("/api/world/transforms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: manifest.artifactId,
          meshes: serializeMeshTransforms(),
          splats: serializeSplatTransforms(),
          sceneAlignment: serializeSceneAlignment()
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Save failed (${response.status})`);
      }
      setPersistState("saved");
      setPersistMessage(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setPersistState("error");
      setPersistMessage(err instanceof Error ? err.message : "Failed to save transforms");
    }
  }, [
    isPersistableArtifact,
    manifest.artifactId,
    serializeMeshTransforms,
    serializeSceneAlignment,
    serializeSplatTransforms
  ]);

  const schedulePersist = useCallback(() => {
    if (!isPersistableArtifact) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistTransforms();
    }, 650);
  }, [isPersistableArtifact, persistTransforms]);

  const resolveSelectedAlignmentRoot = useCallback((): THREE.Object3D | null => {
    const alignmentRoot = alignmentRootRef.current;
    if (!alignmentRoot) return null;
    if (selectedKindRef.current === "group") return alignmentRoot;
    const selected = selectedRef.current;
    if (!selected || selected === alignmentRoot) return alignmentRoot;
    let current: THREE.Object3D | null = selected;
    while (current && current.parent && current.parent !== alignmentRoot) {
      current = current.parent;
    }
    if (current && (current === alignmentRoot || current.parent === alignmentRoot)) {
      return current;
    }
    return alignmentRoot;
  }, []);

  const collectPlySupportPointsForTarget = useCallback(async (targetRoot: THREE.Object3D): Promise<THREE.Vector3[]> => {
    const belongsToTarget = (object: THREE.Object3D) => {
      let current: THREE.Object3D | null = object;
      while (current) {
        if (current === targetRoot) return true;
        current = current.parent;
      }
      return false;
    };

    const worldPoints: THREE.Vector3[] = [];
    for (const handle of splatHandlesRef.current) {
      if (!belongsToTarget(handle.object)) continue;
      const sourceUrl = handle.sourceUrl;
      if (!sourceUrl) continue;
      const lowerSource = sourceUrl.toLowerCase();
      const isPly =
        (handle.formatHint ?? "").toLowerCase() === "ply" ||
        lowerSource.endsWith(".ply") ||
        lowerSource.includes(".ply?");
      if (!isPly) continue;

      const cacheKey = handle.sourceKey ?? sourceUrl;
      let localPoints = splatSupportSampleCacheRef.current.get(cacheKey);
      if (!localPoints) {
        localPoints = await sample3dgsPointsFromUrl(sourceUrl, 60000);
        if (localPoints.length > 0) {
          splatSupportSampleCacheRef.current.set(cacheKey, localPoints);
        }
      }
      if (!localPoints || localPoints.length === 0) continue;

      handle.object.updateMatrixWorld(true);
      const matrixWorld = handle.object.matrixWorld;
      for (const point of localPoints) {
        worldPoints.push(point.clone().applyMatrix4(matrixWorld));
      }
    }
    return worldPoints;
  }, []);

  const runGroundPlaneAlignment = useCallback(
    async (
      targetRoot: THREE.Object3D,
      options?: {
        persist?: boolean;
        debug?: boolean;
        label?: string;
      }
    ) => {
      clearGroundAlignDebug();
      let result = alignSceneToGroundPlane(targetRoot, {
        ...GROUND_ALIGN_OPTIONS,
        debug: options?.debug ?? false
      });
      let sourceSupportCount = 0;

      if (!result.ok) {
        const sourceSupportPoints = await collectPlySupportPointsForTarget(targetRoot);
        sourceSupportCount = sourceSupportPoints.length;
        if (sourceSupportPoints.length >= 3) {
          result = alignSceneToGroundPlane(targetRoot, {
            ...GROUND_ALIGN_OPTIONS,
            debug: options?.debug ?? false,
            externalSupportPoints: sourceSupportPoints
          });
        }
      }

      if (!result.ok) {
        setTransformDebug(
          `groundAlign failed: ${result.reason ?? "unknown error"} (sourcePoints=${sourceSupportCount})`
        );
        return false;
      }

      if (result.debugGroup) {
        sceneRef.current?.add(result.debugGroup);
        groundAlignDebugGroupRef.current = result.debugGroup;
      }

      if (selectedKindRef.current) {
        syncTransformDraftForCurrentSelection();
      }

      const normalText = result.fittedNormal
        ? `(${result.fittedNormal.x.toFixed(3)},${result.fittedNormal.y.toFixed(3)},${result.fittedNormal.z.toFixed(3)})`
        : "(n/a)";
      setTransformDebug(
        `groundAlign target=${options?.label ?? "scene"} vertices=${result.sampledVertexCount} candidates=${result.supportCandidateCount} inliers=${result.inlierCount} sourcePoints=${sourceSupportCount} normal=${normalText} angle=${result.rotationAngleDeg.toFixed(2)}deg`
      );

      if (options?.persist ?? true) {
        schedulePersist();
      }
      return true;
    },
    [
      clearGroundAlignDebug,
      collectPlySupportPointsForTarget,
      schedulePersist,
      syncTransformDraftForCurrentSelection
    ]
  );

  const autoAlignSceneToGroundPlane = useCallback(
    async (persist = true, selectionOnly = false, debugOverride?: boolean) => {
      const alignmentRoot = alignmentRootRef.current;
      if (!alignmentRoot) return false;
      const targetRoot = selectionOnly ? (resolveSelectedAlignmentRoot() ?? alignmentRoot) : alignmentRoot;
      const label = selectionOnly && targetRoot !== alignmentRoot ? "selected" : "scene";
      return await runGroundPlaneAlignment(targetRoot, {
        persist,
        debug: debugOverride ?? groundAlignDebug,
        label
      });
    },
    [groundAlignDebug, resolveSelectedAlignmentRoot, runGroundPlaneAlignment]
  );

  const resetSceneAlignment = useCallback(
    (persist = true) => {
      clearGroundAlignDebug();
      applyPersistedSceneAlignment(null);
      if (selectedKindRef.current) {
        syncTransformDraftForCurrentSelection();
      }
      setTransformDebug("sceneAlign reset -> identity transform");
      if (persist) {
        schedulePersist();
      }
    },
    [
      applyPersistedSceneAlignment,
      clearGroundAlignDebug,
      schedulePersist,
      syncTransformDraftForCurrentSelection
    ]
  );

  const queueAutoAlignScene = useCallback(
    (persist = true) => {
      if (autoAlignTimerRef.current) {
        clearTimeout(autoAlignTimerRef.current);
      }
      autoAlignTimerRef.current = setTimeout(() => {
        autoAlignTimerRef.current = null;
        const alignmentRoot = alignmentRootRef.current;
        if (!alignmentRoot) return;
        void runGroundPlaneAlignment(alignmentRoot, { persist, debug: false, label: "scene" });
      }, 160);
    },
    [runGroundPlaneAlignment]
  );

  const loadPersistedTransforms = useCallback(async (): Promise<PersistedViewerTransforms> => {
    if (!isPersistableArtifact || !manifest.artifactId) {
      return { meshes: {}, splats: {}, sceneAlignment: null };
    }
    try {
      const response = await fetch(`/api/world/transforms?artifactId=${encodeURIComponent(manifest.artifactId)}`, {
        cache: "no-store"
      });
      if (!response.ok) return { meshes: {}, splats: {}, sceneAlignment: null };
      const payload = (await response.json()) as {
        payload?: {
          meshes?: Record<string, MeshTransformRecord>;
          splats?: Record<string, MeshTransformRecord>;
          sceneAlignment?: MeshTransformRecord | null;
        };
      };
      return {
        meshes: payload.payload?.meshes ?? {},
        splats: payload.payload?.splats ?? {},
        sceneAlignment: payload.payload?.sceneAlignment ?? null
      };
    } catch {
      return { meshes: {}, splats: {}, sceneAlignment: null };
    }
  }, [isPersistableArtifact, manifest.artifactId]);

  const clearSelectedHelper = useCallback(() => {
    const helper = selectedBoxRef.current;
    if (!helper) return;
    const scene = sceneRef.current;
    if (scene) scene.remove(helper);
    const helperWithGeometry = helper as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    helperWithGeometry.geometry?.dispose?.();
    const helperWithMaterial = helper as THREE.Object3D & {
      material?: THREE.Material | THREE.Material[];
    };
    if (Array.isArray(helperWithMaterial.material)) {
      helperWithMaterial.material.forEach((material) => material.dispose?.());
    } else {
      helperWithMaterial.material?.dispose?.();
    }
    selectedBoxRef.current = null;
  }, []);

  const styleSelectionHelperMaterial = useCallback((material: THREE.Material) => {
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = true;
    material.opacity = 0.95;
  }, []);

  const attachMeshSelectionBox = useCallback(
    (target: THREE.Object3D) => {
      const scene = sceneRef.current;
      target.updateMatrixWorld(true);
      const box = new THREE.BoxHelper(target, 0x34d399);
      box.renderOrder = 9998;
      styleSelectionHelperMaterial(box.material as THREE.Material);
      if (scene) scene.add(box);
      selectedBoxRef.current = box;
    },
    [styleSelectionHelperMaterial]
  );

  const attachSplatSelectionBox = useCallback(
    (target: THREE.Object3D, bounds?: THREE.Box3) => {
      const scene = sceneRef.current;
      target.updateMatrixWorld(true);
      const box = bounds?.clone().applyMatrix4(target.matrixWorld) ?? new THREE.Box3().setFromObject(target);
      if (box.isEmpty()) return;
      const helper = new THREE.Box3Helper(box, 0x38bdf8);
      helper.renderOrder = 9998;
      styleSelectionHelperMaterial(helper.material as THREE.Material);
      if (scene) scene.add(helper);
      selectedBoxRef.current = helper;
    },
    [styleSelectionHelperMaterial]
  );

  const attachGroupSelectionBox = useCallback(
    (group: ActiveObjectGroup | null) => {
      if (!group || group.members.length === 0) return;
      const scene = sceneRef.current;
      const box = computeUnionBoundsForObjects(group.members.map((entry) => entry.object));
      if (!box || box.isEmpty()) return;
      const helper = new THREE.Box3Helper(box, 0x34d399);
      helper.renderOrder = 9998;
      styleSelectionHelperMaterial(helper.material as THREE.Material);
      if (scene) scene.add(helper);
      selectedBoxRef.current = helper;
    },
    [styleSelectionHelperMaterial]
  );

  const setSelectedGroup = useCallback(
    (group: ActiveObjectGroup | null) => {
      outlinePassRef.current?.selectedObjects.splice(0);
      if (transformControlsRef.current) {
        transformControlsRef.current.detach();
        transformControlsRef.current.visible = false;
      }
      clearSelectedHelper();
      if (!group) {
        selectedRef.current = null;
        setSelectedKind(null);
        setSelectedName(null);
        setTransformDraft(null);
        setTransformDebug("No object selected");
        return;
      }

      selectedRef.current = group.members[0]?.object ?? null;
      setSelectedKind("group");
      setSelectedName(group.id);
      attachGroupSelectionBox(group);
      syncTransformDraftFromGroup(group);
    },
    [attachGroupSelectionBox, clearSelectedHelper, syncTransformDraftFromGroup]
  );

  const setSelectedObject = useCallback(
    (object: THREE.Object3D | null, kind: SelectableSceneObjectKind | null = null) => {
      const splatHandle = object
        ? [...splatHandlesRef.current].find((handle) => handle.object === object) ?? null
        : null;
      const resolvedKind: SelectableSceneObjectKind | null = object
        ? kind ??
          (meshRootsRef.current.includes(object)
            ? "mesh"
            : splatHandle
              ? "splat"
              : null)
        : null;

      const controls = transformControlsRef.current;
      const outlinePass = outlinePassRef.current;
      if (outlinePass) {
        outlinePass.selectedObjects = [];
      }
      if (controls) {
        controls.detach();
        controls.visible = false;
      }

      selectedRef.current = object;
      setSelectedKind(resolvedKind);
      setSelectedName(
        object
          ? resolvedKind === "splat"
            ? (splatHandle?.id ?? object.name ?? object.uuid)
            : object.name || object.uuid
          : null
      );

      clearSelectedHelper();
      if (object && resolvedKind === "mesh") {
        object.traverse((node: THREE.Object3D) => {
          node.matrixAutoUpdate = true;
        });
        if (outlinePass) {
          outlinePass.selectedObjects = [object];
        } else {
          attachMeshSelectionBox(object);
        }
        if (controls) {
          controls.attach(object);
          controls.setMode(transformModeRef.current);
          controls.setSpace(transformSpaceRef.current);
          controls.visible = true;
          controls.enabled = true;
        }
        syncTransformDraft(object);
        return;
      }
      if (object && resolvedKind === "splat") {
        object.matrixAutoUpdate = true;
        attachSplatSelectionBox(object, splatHandle?.bounds);
        if (controls) {
          controls.attach(object);
          controls.setMode(transformModeRef.current);
          controls.setSpace(transformSpaceRef.current);
          controls.visible = true;
          controls.enabled = true;
        }
        syncTransformDraft(object);
        setTransformDebug("Selected splat.");
        return;
      }
      setTransformDraft(null);
      setTransformDebug("No object selected");
    },
    [attachMeshSelectionBox, attachSplatSelectionBox, clearSelectedHelper, syncTransformDraft]
  );

  const applyMarkedSelectionKeys = useCallback(
    (keys: string[]) => {
      const normalized = [...new Set(keys)].filter((key) => {
        const parsed = parseObjectItemKey(key);
        if (!parsed) return false;
        if (parsed.kind !== "mesh") return false;
        return Boolean(resolveObjectByKindAndId(parsed.kind, parsed.id)?.parent);
      });
      setGroupSelectionKeys(normalized);
      if (normalized.length === 1) {
        const parsed = parseObjectItemKey(normalized[0]);
        if (!parsed) return;
        const object = resolveObjectByKindAndId(parsed.kind, parsed.id);
        if (object) {
          setSelectedObject(object, parsed.kind);
        }
        return;
      }
      if (normalized.length > 1) {
        setSelectedGroup(null);
        setTransformDebug(`selected ${normalized.length} objects`);
      }
    },
    [resolveObjectByKindAndId, setSelectedGroup, setSelectedObject]
  );

  const removeObjectFromActiveGroup = useCallback(
    (kind: SelectableSceneObjectKind, id: string) => {
      const group = activeGroupRef.current;
      if (!group) return;
      const key = buildObjectItemKey(kind, id);
      if (!group.members.some((member) => member.key === key)) return;

      group.members = group.members.filter((member) => member.key !== key);
      setGroupSelectionKeys((current) => current.filter((entry) => entry !== key));

      if (group.members.length < 2) {
        const fallback = group.members[0] ?? null;
        activeGroupRef.current = null;
        setActiveGroupMeta(null);
        rotationDisplayRef.current.delete(group.id);
        if (selectedKind === "group") {
          if (fallback) {
            setSelectedObject(fallback.object, fallback.kind);
          } else {
            setSelectedObject(null);
          }
        }
        setTransformDebug("Group dissolved: fewer than two objects remain.");
        return;
      }

      setActiveGroupMeta({
        id: group.id,
        name: group.name,
        memberCount: group.members.length
      });
      if (selectedKind === "group") {
        setSelectedGroup(group);
      }
    },
    [selectedKind, setSelectedGroup, setSelectedObject]
  );

  const removeMeshFromScene = useCallback(
    (meshId: string) => {
      if (!meshId) return;
      removedMeshIdsRef.current.add(meshId);
      setRemovedMeshIds((current) => (current.includes(meshId) ? current : [...current, meshId]));

      const targetIndex = meshRootsRef.current.findIndex((entry) => {
        const sourceMeshId = (entry.userData?.sourceMeshId as string | undefined) ?? null;
        return sourceMeshId === meshId || (entry.name || entry.uuid) === meshId;
      });
      if (targetIndex < 0) return;

      const [target] = meshRootsRef.current.splice(targetIndex, 1);
      target.parent?.remove(target);
      removeObjectFromActiveGroup("mesh", target.name || target.uuid);
      if (selectedRef.current === target) {
        setSelectedObject(null);
      }
      rotationDisplayRef.current.delete(target.uuid);
      setGroupSelectionKeys((current) =>
        current.filter((entry) => entry !== buildObjectItemKey("mesh", target.name || target.uuid))
      );
      disposeObjectTree(target);
      refreshMeshItems();
      setTransformDebug(`removed mesh=${meshId}`);
    },
    [refreshMeshItems, removeObjectFromActiveGroup, setSelectedObject]
  );

  const removeSplatFromScene = useCallback(
    (sourceKey: string) => {
      if (!sourceKey) return;
      removedSplatSourceKeysRef.current.add(sourceKey);
      setRemovedSplatSourceKeys((current) => (current.includes(sourceKey) ? current : [...current, sourceKey]));

      let removedAny = false;
      for (const handle of [...splatHandlesRef.current]) {
        if (handle.sourceKey !== sourceKey) continue;
        splatHandlesRef.current.delete(handle);
        handle.object.parent?.remove(handle.object);
        removeObjectFromActiveGroup("splat", handle.id);
        if (selectedRef.current === handle.object) {
          setSelectedObject(null);
        }
        setGroupSelectionKeys((current) =>
          current.filter((entry) => entry !== buildObjectItemKey("splat", handle.id))
        );
        handle.dispose?.();
        removedAny = true;
      }
      if (!removedAny) return;

      refreshSplatItems();
      updateHudFromHandles();
      setTransformDebug(`removed splat=${sourceKey}`);
    },
    [refreshSplatItems, removeObjectFromActiveGroup, setSelectedObject, updateHudFromHandles]
  );

  const selectObjectItem = useCallback(
    (kind: SelectableSceneObjectKind, itemId: string) => {
      if (kind === "mesh") {
        const target = meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === itemId) ?? null;
        setSelectedObject(target, "mesh");
        return;
      }
      const handle = [...splatHandlesRef.current].find((entry) => entry.id === itemId) ?? null;
      setSelectedObject(handle?.object ?? null, "splat");
    },
    [setSelectedObject]
  );

  const removeObjectItem = useCallback(
    (kind: SelectableSceneObjectKind, itemId: string) => {
      if (kind === "mesh") {
        const target = meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === itemId) ?? null;
        const sourceMeshId = (target?.userData?.sourceMeshId as string | undefined) ?? itemId;
        removeMeshFromScene(sourceMeshId);
      } else {
        const handle = [...splatHandlesRef.current].find((entry) => entry.id === itemId) ?? null;
        if (handle?.sourceKey) {
          removeSplatFromScene(handle.sourceKey);
        }
      }
      setObjectContextMenu(null);
    },
    [removeMeshFromScene, removeSplatFromScene]
  );

  const toggleObjectMarkedForGroup = useCallback((kind: SelectableSceneObjectKind, itemId: string) => {
    if (kind !== "mesh") return;
    const key = buildObjectItemKey(kind, itemId);
    objectListSelectionAnchorRef.current = key;
    setGroupSelectionKeys((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  }, []);

  const clearMarkedGroupSelection = useCallback(() => {
    objectListSelectionAnchorRef.current = null;
    setGroupSelectionKeys([]);
  }, []);

  const createGroupFromMarkedSelection = useCallback(() => {
    const members = groupSelectionKeys
      .map((key) => resolveObjectByKey(key))
      .filter((value): value is ActiveGroupMember => Boolean(value?.object?.parent));
    const unique = new Map<string, ActiveGroupMember>();
    members.forEach((entry) => unique.set(entry.key, entry));
    const nextMembers = [...unique.values()];
    if (nextMembers.length < 2) {
      setTransformDebug("Select at least 2 objects to create a group.");
      return;
    }

    const bounds = computeUnionBoundsForObjects(nextMembers.map((entry) => entry.object));
    if (!bounds || bounds.isEmpty()) {
      setTransformDebug("Unable to compute group bounds.");
      return;
    }

    const centerWorld = bounds.getCenter(new THREE.Vector3());
    const alignmentRoot = alignmentRootRef.current;
    const centerLocal = alignmentRoot ? alignmentRoot.worldToLocal(centerWorld.clone()) : centerWorld.clone();
    const nextIndex = groupCounterRef.current;
    groupCounterRef.current += 1;
    const id = `group-${nextIndex}`;
    const name = `Group ${nextIndex}`;
    const group: ActiveObjectGroup = {
      id,
      name,
      members: nextMembers.map((member) => ({
        ...member,
        baselineLocal: objectToTransformRecord(member.object)
      })),
      initialTransform: {
        position: [centerLocal.x, centerLocal.y, centerLocal.z],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1]
      },
      position: centerLocal.clone(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1)
    };

    activeGroupRef.current = group;
    setActiveGroupMeta({
      id: group.id,
      name: group.name,
      memberCount: group.members.length
    });
    rotationDisplayRef.current.delete(group.id);
    setSelectedGroup(group);
  }, [groupSelectionKeys, resolveObjectByKey, setSelectedGroup]);

  const selectActiveGroup = useCallback(() => {
    const group = activeGroupRef.current;
    if (!group) return;
    setSelectedGroup(group);
  }, [setSelectedGroup]);

  const ungroupActiveSelection = useCallback(
    (clearMarks = false) => {
      const group = activeGroupRef.current;
      if (!group) return;
      const fallback = group.members[0] ?? null;
      activeGroupRef.current = null;
      setActiveGroupMeta(null);
      rotationDisplayRef.current.delete(group.id);
      if (clearMarks) {
        setGroupSelectionKeys([]);
      }
      if (selectedKind === "group") {
        if (fallback) {
          setSelectedObject(fallback.object, fallback.kind);
        } else {
          setSelectedObject(null);
        }
      }
      setTransformDebug(`Ungrouped ${group.members.length} objects.`);
    },
    [selectedKind, setSelectedObject]
  );

  const updateTransformDraftValue = useCallback(
    (section: keyof TransformDraft, axisIndex: 0 | 1 | 2, value: string) => {
      setTransformDraft((current) => {
        if (!current) return current;
        const next: TransformDraft = {
          position: [...current.position] as [string, string, string],
          rotation: [...current.rotation] as [string, string, string],
          scale: [...current.scale] as [string, string, string]
        };
        next[section][axisIndex] = value;
        return next;
      });
    },
    []
  );

  const resolveSelectedObject = useCallback((): THREE.Object3D | null => {
    if (selectedKind === "group") return null;
    const selectedId = selectedName;
    if (selectedId && selectedKind === "mesh") {
      return meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === selectedId) ?? selectedRef.current;
    }
    if (selectedId && selectedKind === "splat") {
      return [...splatHandlesRef.current].find((entry) => entry.id === selectedId)?.object ?? selectedRef.current;
    }
    return selectedRef.current;
  }, [selectedKind, selectedName]);

  const syncLiveSplatSelectionBox = useCallback(() => {
    if (selectedKind !== "splat") return;
    const helper = selectedBoxRef.current;
    if (!(helper instanceof THREE.Box3Helper)) return;
    const selectedId = selectedName;
    if (!selectedId) return;
    const handle = [...splatHandlesRef.current].find((entry) => entry.id === selectedId);
    if (!handle?.bounds) return;
    helper.box.copy(handle.bounds).applyMatrix4(handle.object.matrixWorld);
    helper.updateMatrixWorld(true);
  }, [selectedKind, selectedName]);

  const syncLiveGroupSelectionBox = useCallback(() => {
    if (selectedKind !== "group") return;
    const helper = selectedBoxRef.current;
    if (!(helper instanceof THREE.Box3Helper)) return;
    const group = activeGroupRef.current;
    if (!group || group.members.length === 0) return;
    const box = computeUnionBoundsForObjects(group.members.map((member) => member.object));
    if (!box || box.isEmpty()) return;
    helper.box.copy(box);
    helper.updateMatrixWorld(true);
  }, [selectedKind]);

  const applyTransformFromDraft = useCallback(
    (draft: TransformDraft, commit: boolean) => {
      const read = (value: string, fallback: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      if (selectedKind === "group") {
        const group = activeGroupRef.current;
        if (!group) return false;

        const currentEuler =
          rotationDisplayRef.current.get(group.id) ?? stabilizeEulerXYZForDisplay(group.quaternion, undefined);
        const px = read(draft.position[0], group.position.x);
        const py = read(draft.position[1], group.position.y);
        const pz = read(draft.position[2], group.position.z);
        const rx = read(draft.rotation[0], THREE.MathUtils.radToDeg(currentEuler[0]));
        const ry = read(draft.rotation[1], THREE.MathUtils.radToDeg(currentEuler[1]));
        const rz = read(draft.rotation[2], THREE.MathUtils.radToDeg(currentEuler[2]));
        const sx = read(draft.scale[0], group.scale.x);
        const sy = read(draft.scale[1], group.scale.y);
        const sz = read(draft.scale[2], group.scale.z);

        const rxRad = THREE.MathUtils.degToRad(rx);
        const ryRad = THREE.MathUtils.degToRad(ry);
        const rzRad = THREE.MathUtils.degToRad(rz);
        const nextQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rxRad, ryRad, rzRad, "XYZ"));

        const previousMatrix = new THREE.Matrix4().compose(group.position, group.quaternion, group.scale);
        const nextMatrix = new THREE.Matrix4().compose(
          new THREE.Vector3(px, py, pz),
          nextQuaternion,
          new THREE.Vector3(sx, sy, sz)
        );
        const deltaMatrix = new THREE.Matrix4().multiplyMatrices(
          nextMatrix,
          new THREE.Matrix4().copy(previousMatrix).invert()
        );

        for (const member of group.members) {
          const object = member.object;
          const parent = object.parent;
          if (!parent) continue;
          object.updateMatrixWorld(true);
          parent.updateMatrixWorld(true);
          const oldWorld = object.matrixWorld.clone();
          const newWorld = oldWorld.clone().premultiply(deltaMatrix);
          const localMatrix = new THREE.Matrix4().multiplyMatrices(
            new THREE.Matrix4().copy(parent.matrixWorld).invert(),
            newWorld
          );
          const nextPosition = new THREE.Vector3();
          const nextQuaternionMember = new THREE.Quaternion();
          const nextScale = new THREE.Vector3();
          localMatrix.decompose(nextPosition, nextQuaternionMember, nextScale);
          object.position.copy(nextPosition);
          object.quaternion.copy(nextQuaternionMember);
          object.scale.copy(nextScale);
          object.updateMatrixWorld(true);
          rotationDisplayRef.current.delete(object.uuid);
        }

        group.position.set(px, py, pz);
        group.quaternion.copy(nextQuaternion);
        group.scale.set(sx, sy, sz);
        sceneRef.current?.updateMatrixWorld(true);
        rotationDisplayRef.current.set(group.id, [rxRad, ryRad, rzRad]);

        if (commit) {
          schedulePersist();
          setTransformDebug(
            `apply group=${group.name} members=${group.members.length} pos=(${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)})`
          );
          setSelectedGroup(group);
        } else {
          syncLiveGroupSelectionBox();
        }
        return true;
      }

      const object = resolveSelectedObject();
      if (!object) return false;

      const px = read(draft.position[0], object.position.x);
      const py = read(draft.position[1], object.position.y);
      const pz = read(draft.position[2], object.position.z);
      const currentEuler = rotationDisplayRef.current.get(object.uuid) ?? [
        object.rotation.x,
        object.rotation.y,
        object.rotation.z
      ];
      const rx = read(draft.rotation[0], THREE.MathUtils.radToDeg(currentEuler[0]));
      const ry = read(draft.rotation[1], THREE.MathUtils.radToDeg(currentEuler[1]));
      const rz = read(draft.rotation[2], THREE.MathUtils.radToDeg(currentEuler[2]));
      const sx = read(draft.scale[0], object.scale.x);
      const sy = read(draft.scale[1], object.scale.y);
      const sz = read(draft.scale[2], object.scale.z);
      const rxRad = THREE.MathUtils.degToRad(rx);
      const ryRad = THREE.MathUtils.degToRad(ry);
      const rzRad = THREE.MathUtils.degToRad(rz);

      object.position.set(px, py, pz);
      object.rotation.set(rxRad, ryRad, rzRad, "XYZ");
      object.scale.set(sx, sy, sz);
      object.updateWorldMatrix(true, true);
      sceneRef.current?.updateMatrixWorld(true);
      rotationDisplayRef.current.set(object.uuid, [rxRad, ryRad, rzRad]);

      if (commit) {
        schedulePersist();
        setTransformDebug(`apply id=${object.name || object.uuid} pos=(${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)})`);
        const resolvedKind: SelectableSceneObjectKind | null =
          selectedKind === "mesh" || selectedKind === "splat" ? selectedKind : null;
        setSelectedObject(object, resolvedKind);
      } else {
        syncLiveSplatSelectionBox();
      }
      return true;
    },
    [
      resolveSelectedObject,
      schedulePersist,
      selectedKind,
      setSelectedGroup,
      setSelectedObject,
      syncLiveGroupSelectionBox,
      syncLiveSplatSelectionBox
    ]
  );

  const nudgeTransformDraftValue = useCallback(
    (section: keyof TransformDraft, axisIndex: 0 | 1 | 2, direction: -1 | 1) => {
      if (!transformDraft) return;

      const fallback = section === "scale" ? 1 : 0;
      const raw = transformDraft[section][axisIndex];
      const parsed = Number(raw);
      const base = Number.isFinite(parsed) ? parsed : fallback;
      let nextValue = base + direction * transformStep;
      if (section === "scale") {
        nextValue = Math.max(0.001, nextValue);
      }
      const precision = section === "rotation" ? 2 : 3;
      const next: TransformDraft = {
        position: [...transformDraft.position] as [string, string, string],
        rotation: [...transformDraft.rotation] as [string, string, string],
        scale: [...transformDraft.scale] as [string, string, string]
      };
      next[section][axisIndex] = nextValue.toFixed(precision);
      setTransformDraft(next);
      if (applyTransformFromDraft(next, false)) {
        schedulePersist();
      }
    },
    [applyTransformFromDraft, schedulePersist, transformDraft, transformStep]
  );

  const applyTransformDraft = useCallback(() => {
    if (!transformDraft) return;
    applyTransformFromDraft(transformDraft, true);
  }, [applyTransformFromDraft, transformDraft]);

  const resetSelectedTransform = useCallback(() => {
    if (selectedKind === "group") {
      const group = activeGroupRef.current;
      if (!group) return;
      for (const member of group.members) {
        applyTransformRecord(member.object, member.baselineLocal);
      }
      const [px, py, pz] = group.initialTransform.position;
      const [qx, qy, qz, qw] = group.initialTransform.rotation;
      const [sx, sy, sz] = group.initialTransform.scale;
      group.position.set(px, py, pz);
      group.quaternion.set(qx, qy, qz, qw);
      group.scale.set(sx, sy, sz);
      sceneRef.current?.updateMatrixWorld(true);
      rotationDisplayRef.current.set(group.id, [0, 0, 0]);
      schedulePersist();
      setTransformDebug(`reset group=${group.name} -> grouped baseline`);
      setSelectedGroup(group);
      return;
    }

    const selectedId = selectedName;
    let object: THREE.Object3D | null = null;
    if (selectedId && selectedKind === "mesh") {
      object = meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === selectedId) ?? null;
    } else if (selectedId && selectedKind === "splat") {
      object = [...splatHandlesRef.current].find((entry) => entry.id === selectedId)?.object ?? null;
    }
    object = object ?? selectedRef.current;
    if (!object) return;

    object.position.set(0, 0, 0);
    object.quaternion.set(0, 0, 0, 1);
    object.scale.set(1, 1, 1);
    object.updateMatrixWorld(true);
    sceneRef.current?.updateMatrixWorld(true);
    rotationDisplayRef.current.set(object.uuid, [0, 0, 0]);

    schedulePersist();
    setTransformDebug(`reset id=${object.name || object.uuid} -> identity transform`);
    const resolvedKind: SelectableSceneObjectKind | null =
      selectedKind === "mesh" || selectedKind === "splat" ? selectedKind : null;
    setSelectedObject(object, resolvedKind);
  }, [schedulePersist, selectedKind, selectedName, setSelectedGroup, setSelectedObject]);

  const applySelectedAxisCorrection = useCallback(() => {
    if (selectedKind === "group") {
      const group = activeGroupRef.current;
      if (!group) return;
      const currentEuler =
        rotationDisplayRef.current.get(group.id) ?? stabilizeEulerXYZForDisplay(group.quaternion, undefined);
      const nextDraft: TransformDraft = {
        position: [
          group.position.x.toFixed(3),
          group.position.y.toFixed(3),
          group.position.z.toFixed(3)
        ],
        rotation: [
          THREE.MathUtils.radToDeg(currentEuler[0] - Math.PI / 2).toFixed(2),
          THREE.MathUtils.radToDeg(currentEuler[1]).toFixed(2),
          THREE.MathUtils.radToDeg(currentEuler[2] - Math.PI / 2).toFixed(2)
        ],
        scale: [group.scale.x.toFixed(3), group.scale.y.toFixed(3), group.scale.z.toFixed(3)]
      };
      applyTransformFromDraft(nextDraft, true);
      setTransformDebug(`axis-correct group=${group.name} rotX=-90 rotZ=-90`);
      return;
    }

    const object = resolveSelectedObject();
    if (!object) return;

    // Match modelviewer.html correction path for loaded assets.
    object.rotateX(-Math.PI / 2);
    object.rotateZ(-Math.PI / 2);
    object.updateMatrixWorld(true);
    sceneRef.current?.updateMatrixWorld(true);

    schedulePersist();
    setTransformDebug(`axis-correct id=${object.name || object.uuid} rotX=-90 rotZ=-90`);
    const resolvedKind: SelectableSceneObjectKind | null =
      selectedKind === "mesh" || selectedKind === "splat" ? selectedKind : null;
    setSelectedObject(object, resolvedKind);
  }, [applyTransformFromDraft, resolveSelectedObject, schedulePersist, selectedKind, setSelectedObject]);

  const fitScene = useCallback(() => {
    const root = alignmentRootRef.current ?? rootRef.current;
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!root || !camera || !orbit) return;

    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = maxDim * 1.8;

    camera.position.copy(center.clone().add(new THREE.Vector3(distance, distance * 0.75, distance)));
    camera.near = Math.max(0.0001, distance / 3000);
    camera.far = Math.max(1000, distance * 5000);
    camera.updateProjectionMatrix();
    orbit.target.copy(center);
    orbit.update();
  }, []);

  const applyViewModeProfile = useCallback(
    (mode: ViewMode) => {
      const camera = cameraRef.current;
      const orbit = orbitRef.current;
      if (!camera || !orbit) return;

      if (mode === "modelviewer") {
        camera.fov = 75;
        camera.near = 0.1;
        camera.far = 1000;
        camera.position.set(0, 0, 0);
        camera.updateProjectionMatrix();
        orbit.enableDamping = false;
        orbit.target.set(0, 0, -10);
        orbit.update();
        setNavMode("fly");
        setTransformDebug("viewMode=modelviewer fov=75 near=0.1 far=1000");
        return;
      }

      camera.fov = manifest.camera?.fov ?? 50;
      camera.near = 0.0001;
      camera.far = 4000;
      camera.updateProjectionMatrix();
      orbit.enableDamping = true;
      orbit.target.set(...(manifest.camera?.target ?? [0, 0, 0]));
      orbit.update();
      setNavMode("orbit");
      fitScene();
      setTransformDebug("viewMode=default (fit scene)");
    },
    [fitScene, manifest.camera]
  );

  const switchViewMode = useCallback(
    (mode: ViewMode) => {
      setViewMode(mode);
      applyViewModeProfile(mode);
    },
    [applyViewModeProfile]
  );

  const resetCamera = useCallback(() => {
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!camera || !orbit) return;

    if (viewModeRef.current === "modelviewer") {
      applyViewModeProfile("modelviewer");
      return;
    }

    const preset = manifest.camera;
    const position = preset?.position ?? [4, 3, 4];
    const target = preset?.target ?? [0, 0, 0];

    camera.position.set(position[0], position[1], position[2]);
    orbit.target.set(target[0], target[1], target[2]);
    orbit.update();
  }, [applyViewModeProfile, manifest.camera]);

  const fitSelection = useCallback(() => {
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!camera || !orbit) return;

    let box: THREE.Box3 | null = null;
    if (selectedKind === "group") {
      const group = activeGroupRef.current;
      if (!group || group.members.length === 0) return;
      box = computeUnionBoundsForObjects(group.members.map((member) => member.object));
    } else {
      const selected = selectedRef.current;
      if (!selected) return;
      box = new THREE.Box3().setFromObject(selected);
    }
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const distance = maxDim * 2.2;
    camera.position.copy(center.clone().add(new THREE.Vector3(distance, distance * 0.6, distance)));
    orbit.target.copy(center);
    orbit.update();
  }, [selectedKind]);

  useEffect(() => {
    fitSelectionRef.current = fitSelection;
  }, [fitSelection]);

  const captureScreenshot = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dataUrl = renderer.domElement.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `world_${Date.now()}.png`;
    link.click();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const releaseRenderer = (instance: THREE.WebGLRenderer | null) => {
      if (!instance) return;
      try {
        instance.forceContextLoss?.();
      } catch {
        // Ignore context-loss cleanup failures.
      }
      try {
        instance.dispose();
      } catch {
        // Ignore dispose failures during teardown.
      }
      const canvas = instance.domElement;
      if (canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
    };

    // Defensive cleanup if a previous renderer was not fully released (for example after a hard runtime error).
    releaseRenderer(rendererRef.current);
    rendererRef.current = null;
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    let disposed = false;
    let cancelled = false;
    const initialEnvironment = normalizeEnvironmentConfig(manifest.environment);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const scene = new THREE.Scene();
    scene.background =
      initialEnvironment.backgroundMode === "transparent"
        ? null
        : new THREE.Color(initialEnvironment.backgroundColor);
    sceneRef.current = scene;
    meshRootsRef.current = [];
    setMeshItems([]);
    setSplatItems([]);
    setActiveSplatRuntimes([]);
    setRuntimeNotice(null);
    activeGroupRef.current = null;
    setActiveGroupMeta(null);
    objectListSelectionAnchorRef.current = null;
    loadedExternalAdditionIdsRef.current.clear();
    setGroupSelectionKeys([]);
    setDragSelectionRect(null);
    rotationDisplayRef.current.clear();
    setSelectedObject(null);
    splatSupportSampleCacheRef.current.clear();

    const root = new THREE.Group();
    root.name = "WorldRoot";
    scene.add(root);
    rootRef.current = root;
    const alignmentRoot = new THREE.Group();
    alignmentRoot.name = "WorldContentRoot";
    root.add(alignmentRoot);
    alignmentRootRef.current = alignmentRoot;

    const camera = new THREE.PerspectiveCamera(
      manifest.camera?.fov ?? 50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.0001,
      4000
    );
    camera.position.set(...(manifest.camera?.position ?? [4, 3, 4]));
    cameraRef.current = camera;

    const rendererCandidates: THREE.WebGLRendererParameters[] = [
      { antialias: true, alpha: true, powerPreference: "high-performance" },
      { antialias: false, alpha: true, powerPreference: "high-performance" },
      { antialias: false, alpha: true, powerPreference: "low-power" }
    ];
    let renderer: THREE.WebGLRenderer | null = null;
    let rendererCreationError: Error | null = null;
    for (const candidate of rendererCandidates) {
      try {
        renderer = new THREE.WebGLRenderer(candidate);
        break;
      } catch (err) {
        rendererCreationError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!renderer) {
      const message = rendererCreationError?.message?.trim() || "Error creating WebGL context.";
      setRuntimeNotice(
        "WebGL initialization failed. Close other 3D tabs/apps and reload, or disable canvas-related browser extensions."
      );
      setError(`WebGL init failed: ${message}`);
      setLoading(false);
      cameraRef.current = null;
      sceneRef.current = null;
      rootRef.current = null;
      alignmentRootRef.current = null;
      orbitRef.current = null;
      return () => {
        releaseRenderer(rendererRef.current);
        rendererRef.current = null;
      };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    renderer.toneMapping = resolveToneMapping(initialEnvironment.toneMapping);
    renderer.toneMappingExposure = initialEnvironment.exposure;
    environmentApplyTokenRef.current += 1;
    disposeActiveHdriResources();
    pmremGeneratorRef.current?.dispose();
    pmremGeneratorRef.current = new THREE.PMREMGenerator(renderer);
    pmremGeneratorRef.current.compileEquirectangularShader();

    const hemi = new THREE.HemisphereLight(
      new THREE.Color(initialEnvironment.sunColor),
      new THREE.Color(initialEnvironment.groundColor),
      initialEnvironment.ambientIntensity
    );
    hemi.position.set(0, 30, 0);
    scene.add(hemi);
    hemiLightRef.current = hemi;

    const directional = new THREE.DirectionalLight(
      new THREE.Color(initialEnvironment.sunColor),
      initialEnvironment.sunIntensity
    );
    directional.position.set(8, 12, 6);
    scene.add(directional);
    directionalLightRef.current = directional;

    void applyViewerEnvironment(initialEnvironment);

    const grid = new THREE.GridHelper(24, 48, 0x263245, 0x111827);
    grid.visible = showGridRef.current;
    scene.add(grid);
    gridRef.current = grid;

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.07;
    orbit.zoomSpeed = 0.35;
    orbit.target.set(...(manifest.camera?.target ?? [0, 0, 0]));
    orbit.update();
    orbitRef.current = orbit;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    composer.addPass(new RenderPass(scene, camera));
    composerRef.current = composer;

    let outlinePass: OutlinePass | null = null;
    try {
      outlinePass = new OutlinePass(
        new THREE.Vector2(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)),
        scene,
        camera
      );
      outlinePass.edgeStrength = 5.5;
      outlinePass.edgeGlow = 0.3;
      outlinePass.edgeThickness = 1.4;
      outlinePass.visibleEdgeColor.set("#34d399");
      outlinePass.hiddenEdgeColor.set("#1f2937");
      composer.addPass(outlinePass);
    } catch {
      outlinePass = null;
    }
    outlinePassRef.current = outlinePass;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode(transformModeRef.current);
    transformControls.setSpace(transformSpaceRef.current);
    transformControls.enabled = true;
    transformControls.visible = false;
    const transformControlsHelper = transformControls.getHelper();
    scene.add(transformControlsHelper);
    transformControlsRef.current = transformControls;

    const loader = new GLTFLoader();
    const plyLoader = new PLYLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath("https://unpkg.com/three@0.170.0/examples/jsm/libs/basis/");
    ktx2.detectSupport(renderer);
    loader.setKTX2Loader(ktx2);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        Boolean(target) &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target?.isContentEditable === true);

      if (!isTypingTarget) {
        if (event.code === "Digit1") {
          applyTransformMode("translate");
          event.preventDefault();
        } else if (event.code === "Digit2") {
          applyTransformMode("rotate");
          event.preventDefault();
        } else if (event.code === "Digit3") {
          applyTransformMode("scale");
          event.preventDefault();
        } else if (event.code === "Escape") {
          if (activeGroupRef.current && selectedKindRef.current === "group") {
            setSelectedGroup(null);
          } else {
            setSelectedObject(null);
          }
          event.preventDefault();
        } else if (event.code === "KeyF" && Boolean(selectedKindRef.current)) {
          fitSelectionRef.current();
          event.preventDefault();
        } else if (navModeRef.current !== "fly" && event.code === "KeyW") {
          applyTransformMode("translate");
          event.preventDefault();
        } else if (navModeRef.current !== "fly" && event.code === "KeyE") {
          applyTransformMode("rotate");
          event.preventDefault();
        } else if (navModeRef.current !== "fly" && event.code === "KeyR") {
          applyTransformMode("scale");
          event.preventDefault();
        } else if (navModeRef.current !== "fly" && event.code === "KeyQ") {
          toggleTransformSpace();
          event.preventDefault();
        }
      }

      keysRef.current.add(event.code);
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        transformControls.setTranslationSnap(0.1);
        transformControls.setRotationSnap(THREE.MathUtils.degToRad(5));
        transformControls.setScaleSnap(0.1);
      }
      if (event.code === "Delete" || event.code === "Backspace") {
        if (activeGroupRef.current && selectedKindRef.current === "group") {
          setSelectedGroup(null);
        } else if (selectedRef.current) {
          setSelectedObject(null);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        transformControls.setTranslationSnap(null);
        transformControls.setRotationSnap(null);
        transformControls.setScaleSnap(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let isFlyLookDragging = false;
    let flyLookPointerId: number | null = null;
    let flyLookLastX = 0;
    let flyLookLastY = 0;
    let flyLookYaw = 0;
    let flyLookPitch = 0;
    let isRectSelecting = false;
    let rectSelectPointerId: number | null = null;
    let rectSelectStartX = 0;
    let rectSelectStartY = 0;
    let rectSelectCurrentX = 0;
    let rectSelectCurrentY = 0;
    let orbitWasEnabledBeforeRect = true;

    const onTransformDraggingChanged = (event: THREE.Event & { value: boolean }) => {
      transformDraggingRef.current = Boolean(event.value);
      if (transformDraggingRef.current) {
        orbit.enabled = false;
      } else if (navModeRef.current === "orbit" && !isRectSelecting) {
        orbit.enabled = true;
      }
    };

    const onTransformObjectChange = () => {
      if (selectedKindRef.current !== "mesh" && selectedKindRef.current !== "splat") return;
      syncTransformDraftForCurrentSelection();
      schedulePersist();
    };

    const onTransformMouseUp = () => {
      if (selectedKindRef.current !== "mesh" && selectedKindRef.current !== "splat") return;
      syncTransformDraftForCurrentSelection();
      schedulePersist();
    };

    transformControls.addEventListener("dragging-changed", onTransformDraggingChanged);
    transformControls.addEventListener("objectChange", onTransformObjectChange);
    transformControls.addEventListener("mouseUp", onTransformMouseUp);

    const isDescendantOf = (object: THREE.Object3D, ancestor: THREE.Object3D) => {
      let current: THREE.Object3D | null = object;
      while (current) {
        if (current === ancestor) return true;
        current = current.parent;
      }
      return false;
    };

    const buildRectFromClientPoints = (startX: number, startY: number, endX: number, endY: number) => {
      const canvasRect = rendererRef.current?.domElement.getBoundingClientRect();
      if (!canvasRect) return null;
      const x1 = startX - canvasRect.left;
      const y1 = startY - canvasRect.top;
      const x2 = endX - canvasRect.left;
      const y2 = endY - canvasRect.top;
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1)
      };
    };

    const findObjectAtClientPoint = (
      clientX: number,
      clientY: number
    ): { kind: SelectableSceneObjectKind; id: string; object: THREE.Object3D } | null => {
      if (!rendererRef.current || !cameraRef.current) return null;
      const rect = rendererRef.current.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cameraRef.current);

      const roots = [
        ...meshRootsRef.current,
        ...[...splatHandlesRef.current].map((entry) => entry.object)
      ];
      const intersections = raycaster.intersectObjects(roots, true);
      if (intersections.length === 0) return null;
      const hit = intersections[0]?.object;
      if (!hit) return null;

      let meshCurrent: THREE.Object3D | null = hit;
      while (meshCurrent) {
        if (meshRootsRef.current.includes(meshCurrent)) {
          const id = meshCurrent.name || meshCurrent.uuid;
          return { kind: "mesh", id, object: meshCurrent };
        }
        meshCurrent = meshCurrent.parent;
      }
      for (const handle of splatHandlesRef.current) {
        if (isDescendantOf(hit, handle.object)) {
          return { kind: "splat", id: handle.id, object: handle.object };
        }
      }
      return null;
    };

    const selectObjectsInsideRect = (rect: { x: number; y: number; width: number; height: number }) => {
      const camera = cameraRef.current;
      const renderer = rendererRef.current;
      if (!camera || !renderer) return;
      const width = renderer.domElement.clientWidth;
      const height = renderer.domElement.clientHeight;
      if (width <= 0 || height <= 0) return;

      const cornersForBox = (box: THREE.Box3) => {
        const { min, max } = box;
        return [
          new THREE.Vector3(min.x, min.y, min.z),
          new THREE.Vector3(min.x, min.y, max.z),
          new THREE.Vector3(min.x, max.y, min.z),
          new THREE.Vector3(min.x, max.y, max.z),
          new THREE.Vector3(max.x, min.y, min.z),
          new THREE.Vector3(max.x, min.y, max.z),
          new THREE.Vector3(max.x, max.y, min.z),
          new THREE.Vector3(max.x, max.y, max.z)
        ];
      };

      const intersectsSelectionRect = (box: THREE.Box3) => {
        if (box.isEmpty()) return false;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const corner of cornersForBox(box)) {
          const projected = corner.project(camera);
          if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
          const sx = (projected.x * 0.5 + 0.5) * width;
          const sy = (-projected.y * 0.5 + 0.5) * height;
          if (sx < minX) minX = sx;
          if (sy < minY) minY = sy;
          if (sx > maxX) maxX = sx;
          if (sy > maxY) maxY = sy;
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
          return false;
        }
        return (
          maxX >= rect.x &&
          minX <= rect.x + rect.width &&
          maxY >= rect.y &&
          minY <= rect.y + rect.height
        );
      };

      const selectedKeys: string[] = [];
      for (const meshRoot of meshRootsRef.current) {
        const bounds = new THREE.Box3().setFromObject(meshRoot);
        if (!intersectsSelectionRect(bounds)) continue;
        selectedKeys.push(buildObjectItemKey("mesh", meshRoot.name || meshRoot.uuid));
      }
      applyMarkedSelectionKeys(selectedKeys);
      if (selectedKeys.length === 0) {
        setTransformDebug("selected 0 objects");
      }
    };

    const beginFlyMouseLook = (event: PointerEvent) => {
      if (!cameraRef.current || !rendererRef.current) return;
      const euler = new THREE.Euler().setFromQuaternion(cameraRef.current.quaternion, "YXZ");
      flyLookYaw = euler.y;
      flyLookPitch = euler.x;
      isFlyLookDragging = true;
      flyLookPointerId = event.pointerId;
      flyLookLastX = event.clientX;
      flyLookLastY = event.clientY;
      rendererRef.current.domElement.setPointerCapture?.(event.pointerId);
    };

    const updateFlyMouseLook = (event: PointerEvent) => {
      if (!isFlyLookDragging) return;
      if (flyLookPointerId !== null && event.pointerId !== flyLookPointerId) return;
      const camera = cameraRef.current;
      if (!camera) return;
      const dx = event.clientX - flyLookLastX;
      const dy = event.clientY - flyLookLastY;
      flyLookLastX = event.clientX;
      flyLookLastY = event.clientY;
      const sensitivity = 0.0025;
      flyLookYaw -= dx * sensitivity;
      flyLookPitch = THREE.MathUtils.clamp(flyLookPitch - dy * sensitivity, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
      camera.quaternion.setFromEuler(new THREE.Euler(flyLookPitch, flyLookYaw, 0, "YXZ"));
      camera.updateMatrixWorld(true);
      event.preventDefault();
    };

    const endFlyMouseLook = (event?: PointerEvent) => {
      if (!isFlyLookDragging) return;
      const activePointerId = flyLookPointerId;
      isFlyLookDragging = false;
      flyLookPointerId = null;
      if (activePointerId !== null && rendererRef.current) {
        rendererRef.current.domElement.releasePointerCapture?.(activePointerId);
      }
      event?.preventDefault();
    };

    const onPointerDown = (event: PointerEvent) => {
      setToolMenuOpen(false);
      setViewMenuOpen(false);
      setOpenPanel("none");
      setObjectContextMenu(null);
      setArtifactContextMenu(null);
      if (!rendererRef.current || !cameraRef.current) return;
      if (transformControls.axis || transformDraggingRef.current) {
        return;
      }
      if (event.button === 0 && transformControls.visible) {
        const rect = rendererRef.current.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const gizmoRaycaster =
          (transformControls as unknown as { getRaycaster?: () => THREE.Raycaster }).getRaycaster?.() ?? null;
        if (gizmoRaycaster) {
          gizmoRaycaster.setFromCamera(pointer, cameraRef.current);
          const gizmoHits = gizmoRaycaster.intersectObject(transformControlsHelper, true);
          if (gizmoHits.length > 0) {
            return;
          }
        }
      }
      if (navModeRef.current === "fly" && event.button === 2) {
        beginFlyMouseLook(event);
        event.preventDefault();
        return;
      }
      if (event.button === 0 && event.shiftKey && navModeRef.current !== "fly") {
        isRectSelecting = true;
        rectSelectPointerId = event.pointerId;
        rectSelectStartX = event.clientX;
        rectSelectStartY = event.clientY;
        rectSelectCurrentX = event.clientX;
        rectSelectCurrentY = event.clientY;
        orbitWasEnabledBeforeRect = orbit.enabled;
        orbit.enabled = false;
        const nextRect = buildRectFromClientPoints(
          rectSelectStartX,
          rectSelectStartY,
          rectSelectCurrentX,
          rectSelectCurrentY
        );
        setDragSelectionRect(nextRect);
        rendererRef.current.domElement.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.button !== 0) return;
      const hitItem = findObjectAtClientPoint(event.clientX, event.clientY);
      if (!hitItem) {
        if (selectedKindRef.current === "group") {
          setSelectedGroup(null);
        } else {
          setSelectedObject(null);
        }
        return;
      }
      setSelectedObject(hitItem.object, hitItem.kind);
      objectListSelectionAnchorRef.current = buildObjectItemKey(hitItem.kind, hitItem.id);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (isRectSelecting) {
        if (rectSelectPointerId !== null && event.pointerId !== rectSelectPointerId) return;
        rectSelectCurrentX = event.clientX;
        rectSelectCurrentY = event.clientY;
        const nextRect = buildRectFromClientPoints(
          rectSelectStartX,
          rectSelectStartY,
          rectSelectCurrentX,
          rectSelectCurrentY
        );
        setDragSelectionRect(nextRect);
        event.preventDefault();
        return;
      }
      if (navModeRef.current !== "fly") return;
      updateFlyMouseLook(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (isRectSelecting) {
        if (rectSelectPointerId !== null && event.pointerId !== rectSelectPointerId) return;
        const activePointerId = rectSelectPointerId;
        isRectSelecting = false;
        rectSelectPointerId = null;
        if (activePointerId !== null && rendererRef.current) {
          rendererRef.current.domElement.releasePointerCapture?.(activePointerId);
        }
        orbit.enabled = orbitWasEnabledBeforeRect && navModeRef.current === "orbit";
        const finalRect = buildRectFromClientPoints(
          rectSelectStartX,
          rectSelectStartY,
          rectSelectCurrentX,
          rectSelectCurrentY
        );
        setDragSelectionRect(null);
        if (finalRect) {
          const isClickLike = finalRect.width < 4 && finalRect.height < 4;
          if (isClickLike) {
            const hitItem = findObjectAtClientPoint(event.clientX, event.clientY);
            if (hitItem) {
              const key = buildObjectItemKey(hitItem.kind, hitItem.id);
              objectListSelectionAnchorRef.current = key;
              setGroupSelectionKeys((current) =>
                current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
              );
              setSelectedObject(hitItem.object, hitItem.kind);
            }
          } else {
            selectObjectsInsideRect(finalRect);
          }
        }
        event.preventDefault();
        return;
      }
      if (navModeRef.current !== "fly") return;
      endFlyMouseLook(event);
    };
    const onPointerCancel = () => {
      if (isRectSelecting) {
        const activePointerId = rectSelectPointerId;
        isRectSelecting = false;
        rectSelectPointerId = null;
        if (activePointerId !== null && rendererRef.current) {
          rendererRef.current.domElement.releasePointerCapture?.(activePointerId);
        }
        orbit.enabled = orbitWasEnabledBeforeRect && navModeRef.current === "orbit";
        setDragSelectionRect(null);
      }
      endFlyMouseLook();
    };
    const onCanvasContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
    renderer.domElement.addEventListener("contextmenu", onCanvasContextMenu);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const width = Math.max(1, containerRef.current.clientWidth);
      const height = Math.max(1, containerRef.current.clientHeight);
      rendererRef.current.setSize(width, height);
      composerRef.current?.setSize(width, height);
      outlinePassRef.current?.setSize(width, height);
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    const onVisibilityChange = () => {
      pausedRef.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    type DropInViewerObject = THREE.Object3D & {
      addSplatScene?: (path: string, options?: Record<string, unknown>) => Promise<void>;
      addSplatScenes?: (entries: Array<Record<string, unknown>>) => Promise<void>;
      removeSplatScene?: (index: number, showLoadingUI?: boolean) => Promise<void>;
      dispose?: () => void;
      update?: () => void;
    };
    type SparkRendererObject = {
      update?: (args: { scene: THREE.Scene; viewToWorld?: THREE.Matrix4 }) => void;
      dispose?: () => void;
    };

    const inferSceneFormat = (
      sceneFormatEnum: Record<string, number>,
      url: string,
      formatHint?: "ply" | "splat" | "ksplat" | "spz" | null
    ) => {
      const hint = (formatHint ?? "").toLowerCase();
      if (hint === "ply" && typeof sceneFormatEnum.Ply === "number") return sceneFormatEnum.Ply;
      if (hint === "ksplat" && typeof sceneFormatEnum.KSplat === "number") return sceneFormatEnum.KSplat;
      if (hint === "splat" && typeof sceneFormatEnum.Splat === "number") return sceneFormatEnum.Splat;
      if (hint === "spz" && typeof sceneFormatEnum.Spz === "number") return sceneFormatEnum.Spz;
      const lower = url.toLowerCase();
      if ((lower.endsWith(".ply") || lower.endsWith(".compressed.ply")) && typeof sceneFormatEnum.Ply === "number")
        return sceneFormatEnum.Ply;
      if (lower.endsWith(".ksplat") && typeof sceneFormatEnum.KSplat === "number") return sceneFormatEnum.KSplat;
      if (lower.endsWith(".splat") && typeof sceneFormatEnum.Splat === "number") return sceneFormatEnum.Splat;
      if (lower.endsWith(".spz") && typeof sceneFormatEnum.Spz === "number") return sceneFormatEnum.Spz;
      return undefined;
    };

    const createLegacyDropInViewerObject = async (): Promise<{
      object: DropInViewerObject;
      sceneFormatEnum: Record<string, number>;
    }> => {
      const module = (await getGaussianSplatsModule()) as Record<string, unknown>;
      const DropInViewerCtor = module.DropInViewer as (new (options: Record<string, unknown>) => DropInViewerObject) | undefined;
      if (!DropInViewerCtor) {
        throw new Error("Gaussian splat renderer module does not expose DropInViewer.");
      }
      const sceneFormatEnum = (module.SceneFormat ?? {}) as Record<string, number>;
      const sharedMemoryAllowed = typeof window !== "undefined" && window.crossOriginIsolated === true;
      const object = new DropInViewerCtor({
        selfDrivenMode: false,
        useBuiltInControls: false,
        sharedMemoryForWorkers: sharedMemoryAllowed,
        gpuAcceleratedSort: sharedMemoryAllowed,
        enableSIMDInSort: sharedMemoryAllowed,
        integerBasedSort: false,
        freeIntermediateSplatData: true,
        renderer,
        camera
      });
      object.renderOrder = 1;
      alignmentRoot.add(object);
      return { object, sceneFormatEnum };
    };

    let persistedSplatTransforms: Record<string, MeshTransformRecord> = {};
    let sparkRendererBridge: SparkRendererObject | null = null;

    const buildSplatHandleId = (source: string) => {
      const normalized = source.split("?")[0] ?? source;
      const base = `splat-${stableHash(normalized)}`;
      let id = base;
      let suffix = 1;
      while ([...splatHandlesRef.current].some((handle) => handle.id === id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      return id;
    };

    const buildSplatLabel = (source: string) => {
      const base = source.split("?")[0]?.split("/").pop() || source;
      let decoded = base;
      try {
        decoded = decodeURIComponent(base);
      } catch {
        decoded = base;
      }
      return decoded.length > 0 ? decoded : "Splat";
    };

    const registerSplatHandle = (handle: SplatHandle) => {
      handle.object.name = handle.label;
      splatHandlesRef.current.add(handle);
      const persisted = persistedSplatTransforms[handle.id];
      if (persisted) {
        applyTransformRecord(handle.object, persisted);
      }
      refreshSplatItems();
      updateHudFromHandles();
      if (!selectedRef.current && meshRootsRef.current.length === 0) {
        setSelectedObject(handle.object, "splat");
      }
      if (autoAlignOnLoadRef.current) {
        queueAutoAlignScene(true);
      }
      return handle;
    };

    const ensureSparkRendererBridge = async (): Promise<SparkRendererObject | null> => {
      if (sparkRendererBridge) return sparkRendererBridge;
      const module = await getSparkModule();
      const SparkRendererCtor = module.SparkRenderer as (new (...args: unknown[]) => SparkRendererObject) | undefined;
      if (!SparkRendererCtor) return null;
      const constructorCandidates: Array<unknown[]> = [[{ renderer }]];
      for (const args of constructorCandidates) {
        try {
          sparkRendererBridge = new SparkRendererCtor(...args);
          if ((sparkRendererBridge as unknown as THREE.Object3D).parent !== root) {
            root.add(sparkRendererBridge as unknown as THREE.Object3D);
          }
          return sparkRendererBridge;
        } catch {
          sparkRendererBridge = null;
        }
      }
      return null;
    };

    const createLegacySplatHandleFromUrl = async (
      url: string,
      formatHint?: "ply" | "splat" | "ksplat" | "spz" | null,
      idSource?: string
    ): Promise<SplatHandle> => {
      const { object, sceneFormatEnum } = await createLegacyDropInViewerObject();
      const sceneFormat = inferSceneFormat(sceneFormatEnum, url, formatHint);
      const addOptions: Record<string, unknown> = {
        showLoadingUI: false,
        progressiveLoad: true
      };
      if (sceneFormat !== undefined) addOptions.format = sceneFormat;

      try {
        if (typeof object.addSplatScene === "function") {
          await object.addSplatScene(url, addOptions);
        } else if (typeof object.addSplatScenes === "function") {
          await object.addSplatScenes([{ path: url, ...addOptions }]);
        } else {
          throw new Error("DropInViewer does not support addSplatScene/addSplatScenes APIs.");
        }
        if (!object.children || object.children.length === 0) {
          throw new Error("Gaussian scene loaded with no renderable content.");
        }
      } catch (error) {
        object.parent?.remove(object);
        object.dispose?.();
        throw error;
      }

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object,
        runtime: "legacy",
        sourceKey: normalizeMeshUrlForDedup(idSource ?? url),
        sourceUrl: idSource ?? url,
        formatHint,
        dispose: typeof object.dispose === "function" ? () => object.dispose?.() : undefined,
        update: typeof object.update === "function" ? () => object.update?.() : undefined,
        splatCount: 0
      };
      return registerSplatHandle(handle);
    };

    const createSparkSplatHandleFromUrl = async (
      url: string,
      formatHint?: "ply" | "splat" | "ksplat" | "spz" | null,
      idSource?: string
    ): Promise<SplatHandle> => {
      const module = await getSparkModule();
      const SplatMeshCtor = (module.SplatMesh ?? module.GaussianSplatMesh) as
        | (new (...args: unknown[]) => Record<string, unknown>)
        | undefined;
      if (!SplatMeshCtor) {
        throw new Error("Spark module does not expose SplatMesh.");
      }

      const constructorCandidates: Array<unknown[]> = [
        [{ url, format: formatHint ?? undefined, progressiveLoad: true }],
        [{ url, formatHint: formatHint ?? undefined }],
        [{ src: url, format: formatHint ?? undefined }],
        [url]
      ];

      let instance: Record<string, unknown> | null = null;
      let object: THREE.Object3D | null = null;

      for (const args of constructorCandidates) {
        try {
          const candidate = new SplatMeshCtor(...args);
          const objectCandidate =
            candidate instanceof THREE.Object3D
              ? candidate
              : candidate.object3d instanceof THREE.Object3D
                ? candidate.object3d
                : candidate.object instanceof THREE.Object3D
                  ? candidate.object
                  : null;
          if (!objectCandidate) {
            continue;
          }
          instance = candidate;
          object = objectCandidate;
          break;
        } catch {
          instance = null;
          object = null;
        }
      }

      if (!instance || !object) {
        throw new Error("Unable to construct Spark SplatMesh for this asset.");
      }

      object.renderOrder = 1;
      alignmentRoot.add(object);
      try {
        await waitForSparkSplatReady(instance);
        const bridge = await ensureSparkRendererBridge();
        if (!bridge) {
          throw new Error("SparkRenderer is not available in this environment.");
        }
      } catch (error) {
        object.parent?.remove(object);
        const dispose = instance.dispose;
        if (typeof dispose === "function") {
          (dispose as () => void).call(instance);
        }
        throw error;
      }

      const disposeFn =
        typeof instance.dispose === "function"
          ? () => {
              (instance?.dispose as () => void).call(instance);
            }
          : undefined;

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object,
        runtime: "spark",
        sourceKey: normalizeMeshUrlForDedup(idSource ?? url),
        sourceUrl: idSource ?? url,
        formatHint,
        dispose: disposeFn,
        update: undefined,
        splatCount: 0
      };
      return registerSplatHandle(handle);
    };

    const createSplatHandleFromUrl = async (
      url: string,
      formatHint?: "ply" | "splat" | "ksplat" | "spz" | null,
      idSource?: string
    ): Promise<SplatHandle> => {
      const runtimeErrors: string[] = [];
      for (const runtimeName of preferredRuntimeOrder) {
        try {
          if (runtimeName === "spark") {
            return await createSparkSplatHandleFromUrl(url, formatHint, idSource);
          }
          const handle = await createLegacySplatHandleFromUrl(url, formatHint, idSource);
          if (
            runtimeErrors.some((entry) => entry.startsWith("spark:")) &&
            !disposed &&
            !cancelled
          ) {
            setRuntimeNotice("Spark load failed for one or more splats. Legacy runtime fallback is active.");
          }
          return handle;
        } catch (runtimeError) {
          const message = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
          runtimeErrors.push(`${runtimeName}: ${message}`);
        }
      }
      throw new Error(runtimeErrors.join(" | "));
    };

    const createSurfaceMeshHandleFromPly = async (
      url: string,
      vertexCountHint?: number,
      idSource?: string
    ): Promise<SplatHandle> => {
      const geometry = await plyLoader.loadAsync(url);
      if (!geometry?.getAttribute("position")) {
        throw new Error("PLY surface mesh has no position attribute.");
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const hasVertexColors = Boolean(geometry.getAttribute("color"));
      const material = new THREE.MeshBasicMaterial({
        color: hasVertexColors ? 0xffffff : 0xd4d9e8,
        vertexColors: hasVertexColors,
        side: THREE.DoubleSide
      });
      material.depthTest = true;
      material.depthWrite = true;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `ply-surface-${Date.now()}`;
      mesh.renderOrder = 0;
      // Match modelviewer orientation for Hunyuan/Open3D PLY mesh exports.
      mesh.rotateX(-Math.PI / 2);
      mesh.rotateZ(-Math.PI / 2);
      alignmentRoot.add(mesh);

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object: mesh,
        runtime: "points",
        sourceKey: normalizeMeshUrlForDedup(idSource ?? url),
        sourceUrl: idSource ?? url,
        formatHint: "ply",
        dispose: () => {
          mesh.geometry.dispose();
          material.dispose();
        },
        splatCount: vertexCountHint ?? (geometry.getAttribute("position")?.count ?? 0),
        bounds: geometry.boundingBox?.clone()
      };
      return registerSplatHandle(handle);
    };

    const createPointCloudHandleFromPly = async (
      url: string,
      vertexCountHint?: number,
      idSource?: string
    ): Promise<SplatHandle> => {
      let geometry: THREE.BufferGeometry | null = null;
      try {
        geometry = await tryLoad3dgsBinaryPlyGeometry(url);
      } catch {
        geometry = null;
      }
      if (!geometry) {
        geometry = await plyLoader.loadAsync(url);
      }
      if (!geometry) {
        throw new Error("Failed to create PLY geometry.");
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const hasVertexColors = Boolean(geometry.getAttribute("color"));
      const material = new THREE.PointsMaterial({
        color: hasVertexColors ? 0xffffff : 0xd4d9e8,
        vertexColors: hasVertexColors,
        size: 0.01,
        sizeAttenuation: true
      });
      material.depthTest = true;
      material.depthWrite = true;

      const points = new THREE.Points(geometry, material);
      points.name = `ply-points-${Date.now()}`;
      points.renderOrder = 1;
      alignmentRoot.add(points);

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object: points,
        runtime: "points",
        sourceKey: normalizeMeshUrlForDedup(idSource ?? url),
        sourceUrl: idSource ?? url,
        formatHint: "ply",
        dispose: () => {
          points.geometry.dispose();
          material.dispose();
        },
        splatCount: vertexCountHint ?? (geometry.getAttribute("position")?.count ?? 0),
        bounds: geometry.boundingBox?.clone()
      };
      return registerSplatHandle(handle);
    };

    const loadDirectPlyWithPolicy = async (url: string): Promise<void> => {
      const inspected = await inspectPlyUrl(url);
      const hasFaces = Boolean(inspected?.hasFaces);
      const is3dgs = Boolean(inspected?.is3dgs);
      const vertexCount = inspected?.vertexCount ?? 0;
      if (hasFaces) {
        await createSurfaceMeshHandleFromPly(url, vertexCount > 0 ? vertexCount : undefined, url);
        setRuntimeNotice("PLY loaded as surface mesh.");
        setError(null);
        return;
      }
      if (is3dgs) {
        const sliderFraction = Math.max(0.01, Math.min(1, splatDensityApplied / 100));
        const profileLimit =
          splatLoadProfile === "full" ? 1 : splatLoadProfile === "balanced" ? 0.5 : 0.15;
        const keepFraction = Math.max(0.01, Math.min(sliderFraction, profileLimit));
        let gaussianUrl = url;
        let effectiveVertexCount = vertexCount;
        let splatBounds = await compute3dgsBoundsFromUrl(url);
        if (keepFraction < 0.9999) {
          const downsampled = await buildDownsampled3dgsPlyBlob(url, keepFraction);
          if (downsampled) {
            gaussianUrl = downsampled.blobUrl;
            tempBlobUrlsRef.current.push(downsampled.blobUrl);
            effectiveVertexCount = downsampled.keptVertices;
            if (!splatBounds) {
              splatBounds = await compute3dgsBoundsFromUrl(gaussianUrl);
            }
          }
        }

        try {
          const handle = await createSplatHandleFromUrl(gaussianUrl, "ply", url);
          handle.splatCount = effectiveVertexCount > 0 ? effectiveVertexCount : handle.splatCount;
          handle.bounds = splatBounds ?? undefined;
          refreshSplatItems();
          updateHudFromHandles();
          setError(null);
          return;
        } catch (gaussianError) {
          const message =
            gaussianError instanceof Error ? gaussianError.message : "Unknown gaussian load error";
          console.warn(`[viewer] Gaussian PLY load failed, falling back to point-cloud: ${message}`);
          setRuntimeNotice(`Gaussian runtime failed for a PLY asset. Falling back to point cloud. (${message})`);
          setError(`Gaussian load failed, using point fallback: ${message}`);
        }
      }

      await createPointCloudHandleFromPly(url, vertexCount > 0 ? vertexCount : undefined, url);
      setError(null);
    };

    const loadWorld = async () => {
      try {
        if (disposed || cancelled) return;
        setLoading(true);
        setError(null);
        if (isPersistableArtifact) {
          setPersistState("idle");
          setPersistMessage(null);
        }

        const persistedTransforms = await loadPersistedTransforms();
        persistedSplatTransforms = persistedTransforms.splats;
        const hasSavedAlignment =
          persistedTransforms.sceneAlignment &&
          !isIdentityTransformRecord(persistedTransforms.sceneAlignment);
        autoAlignOnLoadRef.current = !hasSavedAlignment;
        applyPersistedSceneAlignment(hasSavedAlignment ? persistedTransforms.sceneAlignment : null);
        if (disposed || cancelled) return;

        const meshIdUsage = new Map<string, number>();
        const meshLoadErrors: string[] = [];
        const dedupedMeshes = (manifest.meshes ?? []).filter((mesh, index, source) => {
          const key = normalizeMeshUrlForDedup(mesh.url);
          return source.findIndex((candidate) => normalizeMeshUrlForDedup(candidate.url) === key) === index;
        });
        const activeMeshes = dedupedMeshes.filter((mesh) => !removedMeshIdsRef.current.has(mesh.id));

        for (const mesh of activeMeshes) {
          if (disposed || cancelled) break;
          try {
            const shouldLoadPlyMesh = mesh.formatHint === "ply" || urlHasPlyExtension(mesh.url);
            if (shouldLoadPlyMesh) {
              const geometry = await plyLoader.loadAsync(mesh.url);
              if (!geometry?.getAttribute("position")) {
                throw new Error("PLY mesh has no position attribute.");
              }
              geometry.computeBoundingBox();
              geometry.computeBoundingSphere();
              const hasVertexColors = Boolean(geometry.getAttribute("color"));
              const material = new THREE.MeshBasicMaterial({
                color: hasVertexColors ? 0xffffff : 0xd4d9e8,
                vertexColors: hasVertexColors,
                side: THREE.DoubleSide
              });
              material.depthTest = true;
              material.depthWrite = true;
              const plyMesh = new THREE.Mesh(geometry, material);
              // Match modelviewer orientation for Hunyuan/Open3D PLY mesh exports.
              plyMesh.rotateX(-Math.PI / 2);
              plyMesh.rotateZ(-Math.PI / 2);
              plyMesh.traverse((obj: THREE.Object3D) => {
                obj.matrixAutoUpdate = true;
                const meshObj = obj as THREE.Mesh;
                if (!meshObj.isMesh) return;
                meshObj.userData.transformRoot = plyMesh;
              });
              plyMesh.userData.transformRoot = true;
              plyMesh.userData.sourceMeshId = mesh.id;
              plyMesh.userData.sourceMeshKey = normalizeMeshUrlForDedup(mesh.url);
              plyMesh.renderOrder = 0;
              if (disposed || cancelled) {
                disposeObjectTree(plyMesh);
                continue;
              }

              const baseId = mesh.id || plyMesh.name || "mesh";
              const usageCount = meshIdUsage.get(baseId) ?? 0;
              meshIdUsage.set(baseId, usageCount + 1);
              plyMesh.name = usageCount === 0 ? baseId : `${baseId}-${usageCount}`;

              meshRootsRef.current.push(plyMesh);
              alignmentRoot.add(plyMesh);
              continue;
            }

            const gltf = await loader.loadAsync(mesh.url);
            if (disposed || cancelled) {
              disposeObjectTree(gltf.scene);
              continue;
            }
            gltf.scene.traverse((obj: THREE.Object3D) => {
              obj.matrixAutoUpdate = true;
              const meshObj = obj as THREE.Mesh;
              if (!meshObj.isMesh) return;
              meshObj.userData.transformRoot = gltf.scene;
              const applyState = (material: THREE.Material) => {
                material.depthTest = true;
                material.depthWrite = !material.transparent;
              };
              if (Array.isArray(meshObj.material)) meshObj.material.forEach(applyState);
              else if (meshObj.material) applyState(meshObj.material);
            });
            gltf.scene.userData.transformRoot = true;
            gltf.scene.userData.sourceMeshId = mesh.id;
            gltf.scene.userData.sourceMeshKey = normalizeMeshUrlForDedup(mesh.url);
            gltf.scene.renderOrder = 0;

            const baseId = mesh.id || gltf.scene.name || "mesh";
            const usageCount = meshIdUsage.get(baseId) ?? 0;
            meshIdUsage.set(baseId, usageCount + 1);
            gltf.scene.name = usageCount === 0 ? baseId : `${baseId}-${usageCount}`;

            meshRootsRef.current.push(gltf.scene);
            alignmentRoot.add(gltf.scene);
          } catch (meshError) {
            const message = meshError instanceof Error ? meshError.message : "Unknown mesh load error";
            meshLoadErrors.push(`${mesh.id}: ${message}`);
          }
        }

        applyMeshTransforms(persistedTransforms.meshes);
        refreshMeshItems();
        if (meshRootsRef.current.length > 0) {
          setSelectedObject(meshRootsRef.current[0] ?? null);
        }
        if (isPersistableArtifact) {
          setPersistState("saved");
          setPersistMessage(
            hasSavedAlignment
              ? "Loaded saved transforms + scene alignment"
              : "Loaded saved transforms"
          );
        }
        if (meshLoadErrors.length > 0) {
          setError(
            `Loaded ${meshRootsRef.current.length}/${manifest.meshes.length} meshes. Failed: ${meshLoadErrors.join(" | ")}`
          );
        }

        if (directSplats.length > 0) {
          for (const splatEntry of directSplats) {
            if (disposed || cancelled) break;
            const sourceKey = normalizeMeshUrlForDedup(splatEntry.url);
            if (removedSplatSourceKeysRef.current.has(sourceKey)) continue;
            if (splatEntry.formatHint === "ply") {
              void loadDirectPlyWithPolicy(splatEntry.url).catch((splatError) => {
                if (disposed || cancelled) return;
                const message =
                  splatError instanceof Error ? splatError.message : "Failed to load PLY point cloud.";
                setError(message);
              });
            } else {
              void createSplatHandleFromUrl(
                splatEntry.url,
                splatEntry.formatHint,
                splatEntry.url
              ).catch((splatError) => {
                if (disposed || cancelled) return;
                const message = splatError instanceof Error ? splatError.message : "Failed to load splat scene.";
                setError(message);
              });
            }
          }
        } else {
          const hasSplatEntries = (manifest.splats?.length ?? 0) > 0;
          const hasMeshEntries = (manifest.meshes?.length ?? 0) > 0;
          if (hasSplatEntries && !hasMeshEntries) {
            setError((prev) => prev ?? "No direct splat source URL found for this artifact.");
          }
        }

        if (disposed || cancelled) return;
        if (autoAlignOnLoadRef.current) {
          queueAutoAlignScene(true);
        }
        if (viewModeRef.current === "modelviewer") {
          applyViewModeProfile("modelviewer");
        } else {
          fitScene();
        }
      } catch (err) {
        if (disposed || cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load world");
      } finally {
        if (!disposed && !cancelled) {
          setLoading(false);
        }
      }
    };

    void loadWorld();

    const animate = () => {
      if (disposed) return;
      requestRef.current = requestAnimationFrame(animate);

      const dt = Math.min(clockRef.current.getDelta(), 1 / 20);
      if (pausedRef.current) return;

      if (transformDraggingRef.current) {
        orbit.enabled = false;
      } else if (navModeRef.current === "orbit") {
        orbit.enabled = !isRectSelecting;
        if (orbit.enabled) {
          orbit.update();
        }
      } else {
        orbit.enabled = false;
        const keys = keysRef.current;
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        direction.normalize();
        const right = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
        const up = camera.up.clone().normalize();
        const speed = flySpeedRef.current * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1);
        const move = new THREE.Vector3();
        if (keys.has("KeyW")) move.add(direction);
        if (keys.has("KeyS")) move.sub(direction);
        if (keys.has("KeyD")) move.add(right);
        if (keys.has("KeyA")) move.sub(right);
        if (keys.has("KeyE")) move.add(up);
        if (keys.has("KeyQ")) move.sub(up);
        if (move.lengthSq() > 0) {
          move.normalize().multiplyScalar(speed * dt);
          camera.position.add(move);
        }
      }

      if (viewModeRef.current === "modelviewer" && modelviewerAutoRotateRef.current) {
        alignmentRoot.rotation.y += 0.0005;
      }

      for (const handle of [...splatHandlesRef.current]) {
        if (!handle.update) continue;
        try {
          handle.update();
        } catch (updateError) {
          splatHandlesRef.current.delete(handle);
          handle.object.parent?.remove(handle.object);
          handle.dispose?.();
          refreshSplatItems();
          const message =
            updateError instanceof Error ? updateError.message : "Splat renderer update failed.";
          setError(`Splat update failed: ${message}`);
        }
      }
      if (selectedKindRef.current === "group" && selectedBoxRef.current instanceof THREE.Box3Helper) {
        const group = activeGroupRef.current;
        if (group) {
          const groupBounds = computeUnionBoundsForObjects(group.members.map((member) => member.object));
          if (groupBounds && !groupBounds.isEmpty()) {
            selectedBoxRef.current.box.copy(groupBounds);
          }
        }
        selectedBoxRef.current.updateMatrixWorld(true);
      } else if (selectedKindRef.current === "splat" && selectedBoxRef.current instanceof THREE.Box3Helper) {
        const selectedObject = selectedRef.current;
        if (selectedObject) {
          selectedObject.updateMatrixWorld(true);
          const handle = [...splatHandlesRef.current].find((entry) => entry.object === selectedObject) ?? null;
          const box = handle?.bounds
            ? handle.bounds.clone().applyMatrix4(selectedObject.matrixWorld)
            : new THREE.Box3().setFromObject(selectedObject);
          if (!box.isEmpty()) {
            selectedBoxRef.current.box.copy(box);
          }
        }
        selectedBoxRef.current.updateMatrixWorld(true);
      } else if (selectedBoxRef.current instanceof THREE.BoxHelper) {
        selectedBoxRef.current.update();
      }
      const hasSparkRuntime = [...splatHandlesRef.current].some((handle) => handle.runtime === "spark");
      if (hasSparkRuntime && sparkRendererBridge?.update) {
        try {
          sparkRendererBridge.update({
            scene,
            viewToWorld: camera.matrixWorld
          });
        } catch (sparkUpdateError) {
          const message =
            sparkUpdateError instanceof Error ? sparkUpdateError.message : "Unknown Spark update error";
          setRuntimeNotice(`Spark update failed. Falling back to Three.js render path. (${message})`);
        }
      }
      if (!hasSparkRuntime && sparkRendererBridge && (sparkRendererBridge as unknown as THREE.Object3D).parent) {
        root.remove(sparkRendererBridge as unknown as THREE.Object3D);
      } else if (hasSparkRuntime && sparkRendererBridge && (sparkRendererBridge as unknown as THREE.Object3D).parent !== root) {
        root.add(sparkRendererBridge as unknown as THREE.Object3D);
      }
      if (composerRef.current) {
        composerRef.current.render();
      } else {
        renderer.render(scene, camera);
      }

      fpsCounterRef.current.acc += dt;
      fpsCounterRef.current.frames += 1;
      if (fpsCounterRef.current.acc >= 0.25) {
        const nextFps = Math.round(fpsCounterRef.current.frames / fpsCounterRef.current.acc);
        fpsCounterRef.current = { acc: 0, frames: 0, fps: nextFps };
        setFps(nextFps);
        setHud(hudRef.current);
      }
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelled = true;
      pausedRef.current = false;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (autoAlignTimerRef.current) {
        clearTimeout(autoAlignTimerRef.current);
        autoAlignTimerRef.current = null;
      }
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
        requestRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown, true);
      renderer.domElement.removeEventListener("contextmenu", onCanvasContextMenu);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      resizeObserver.disconnect();
      transformControls.removeEventListener("dragging-changed", onTransformDraggingChanged);
      transformControls.removeEventListener("objectChange", onTransformObjectChange);
      transformControls.removeEventListener("mouseUp", onTransformMouseUp);

      activeGroupRef.current = null;
      setActiveGroupMeta(null);
      objectListSelectionAnchorRef.current = null;
      loadedExternalAdditionIdsRef.current.clear();
      setGroupSelectionKeys([]);
      setDragSelectionRect(null);
      setSelectedObject(null);
      clearSelectedHelper();

      transformControls.detach();
      transformControls.visible = false;
      transformDraggingRef.current = false;
      scene.remove(transformControlsHelper);
      transformControls.dispose();
      transformControlsRef.current = null;
      outlinePassRef.current = null;
      const composerInstance = composerRef.current;
      if (composerInstance) {
        for (const pass of composerInstance.passes as Array<{ dispose?: () => void }>) {
          pass.dispose?.();
        }
      }
      composerRef.current = null;

      orbit.dispose();
      draco.dispose();
      ktx2.dispose();

      for (const handle of splatHandlesRef.current) {
        handle.dispose?.();
      }
      if (sparkRendererBridge && (sparkRendererBridge as unknown as THREE.Object3D).parent) {
        root.remove(sparkRendererBridge as unknown as THREE.Object3D);
      }
      sparkRendererBridge?.dispose?.();
      sparkRendererBridge = null;
      splatHandlesRef.current.clear();
      refreshSplatItems();
      updateHudFromHandles();
      for (const blobUrl of tempBlobUrlsRef.current) {
        URL.revokeObjectURL(blobUrl);
      }
      tempBlobUrlsRef.current = [];
      splatSupportSampleCacheRef.current.clear();
      environmentApplyTokenRef.current += 1;
      disposeActiveHdriResources();
      pmremGeneratorRef.current?.dispose();
      pmremGeneratorRef.current = null;
      hemiLightRef.current = null;
      directionalLightRef.current = null;

      clearGroundAlignDebug();
      disposeObjectTree(root);
      scene.clear();
      gridRef.current = null;
      releaseRenderer(renderer);
      rendererRef.current = null;
      sceneRef.current = null;
      rootRef.current = null;
      alignmentRootRef.current = null;
      cameraRef.current = null;
      orbitRef.current = null;
    };
  }, [
    applyMarkedSelectionKeys,
    applyViewerEnvironment,
    applyPersistedSceneAlignment,
    applyMeshTransforms,
    clearGroundAlignDebug,
    disposeActiveHdriResources,
    directSplats,
    applyTransformMode,
    applyViewModeProfile,
    fitScene,
    isPersistableArtifact,
    loadPersistedTransforms,
    manifest,
    refreshMeshItems,
    refreshSplatItems,
    schedulePersist,
    clearSelectedHelper,
    setSelectedGroup,
    setSelectedObject,
    preferredRuntimeOrder,
    queueAutoAlignScene,
    splatLoadProfile,
    splatDensityApplied,
    toggleTransformSpace,
    updateHudFromHandles
  ]);

  useEffect(() => {
    if (loading) return;
    const alignmentRoot = alignmentRootRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!alignmentRoot || !renderer || !camera) return;

    const pending = (externalSceneAdditions ?? []).filter(
      (entry) => typeof entry.id === "string" && entry.id.length > 0 && !loadedExternalAdditionIdsRef.current.has(entry.id)
    );
    if (pending.length === 0) return;

    let cancelled = false;

    const inferSplatSceneFormat = (
      sceneFormatEnum: Record<string, number>,
      url: string,
      kind: string,
      filename?: string | null
    ): number | undefined => {
      const lowerKind = kind.toLowerCase();
      const lower = url.toLowerCase();
      const lowerName = (filename ?? "").toLowerCase();
      const source = `${lower} ${lowerName}`;
      if ((lowerKind === "point_ply" || lower.endsWith(".ply") || lower.endsWith(".compressed.ply")) && typeof sceneFormatEnum.Ply === "number") {
        return sceneFormatEnum.Ply;
      }
      if (source.includes(".ksplat") && typeof sceneFormatEnum.KSplat === "number") return sceneFormatEnum.KSplat;
      if (source.includes(".splat") && typeof sceneFormatEnum.Splat === "number") return sceneFormatEnum.Splat;
      if (source.includes(".spz") && typeof sceneFormatEnum.Spz === "number") return sceneFormatEnum.Spz;
      return undefined;
    };

    const buildUniqueMeshName = (seed: string) => {
      let base = seed.trim();
      if (base.length === 0) base = "external-mesh";
      let name = base;
      let counter = 1;
      const existingNames = new Set(meshRootsRef.current.map((entry) => entry.name || entry.uuid));
      while (existingNames.has(name)) {
        name = `${base}-${counter}`;
        counter += 1;
      }
      return name;
    };

    const attachLoadedMesh = (object: THREE.Object3D, sourceId: string, sourceUrl: string) => {
      const meshName = buildUniqueMeshName(sourceId);
      object.name = meshName;
      object.userData.transformRoot = true;
      object.userData.sourceMeshId = sourceId;
      object.userData.sourceMeshKey = normalizeMeshUrlForDedup(sourceUrl);
      meshRootsRef.current.push(object);
      alignmentRoot.add(object);
      refreshMeshItems();
      objectListSelectionAnchorRef.current = buildObjectItemKey("mesh", meshName);
      setSelectedObject(object, "mesh");
    };

    const loadExternalMeshGlb = async (addition: ExternalSceneAddition) => {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const ktx2 = new KTX2Loader();
      ktx2.setTranscoderPath("https://unpkg.com/three@0.170.0/examples/jsm/libs/basis/");
      ktx2.detectSupport(renderer);
      loader.setKTX2Loader(ktx2);
      try {
        const gltf = await loader.loadAsync(addition.url);
        if (cancelled) {
          disposeObjectTree(gltf.scene);
          return;
        }
        gltf.scene.traverse((obj: THREE.Object3D) => {
          obj.matrixAutoUpdate = true;
          const meshObj = obj as THREE.Mesh;
          if (!meshObj.isMesh) return;
          meshObj.userData.transformRoot = gltf.scene;
          const applyState = (material: THREE.Material) => {
            material.depthTest = true;
            material.depthWrite = !material.transparent;
          };
          if (Array.isArray(meshObj.material)) meshObj.material.forEach(applyState);
          else if (meshObj.material) applyState(meshObj.material);
        });
        attachLoadedMesh(gltf.scene, addition.id, addition.url);
      } finally {
        draco.dispose();
        ktx2.dispose();
      }
    };

    const loadExternalMeshPly = async (addition: ExternalSceneAddition) => {
      const loader = new PLYLoader();
      const geometry = await loader.loadAsync(addition.url);
      if (!geometry?.getAttribute("position")) {
        throw new Error("PLY mesh has no position attribute.");
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const hasVertexColors = Boolean(geometry.getAttribute("color"));
      const material = new THREE.MeshBasicMaterial({
        color: hasVertexColors ? 0xffffff : 0xd4d9e8,
        vertexColors: hasVertexColors,
        side: THREE.DoubleSide
      });
      material.depthTest = true;
      material.depthWrite = true;
      const plyMesh = new THREE.Mesh(geometry, material);
      plyMesh.rotateX(-Math.PI / 2);
      plyMesh.rotateZ(-Math.PI / 2);
      plyMesh.traverse((obj: THREE.Object3D) => {
        obj.matrixAutoUpdate = true;
        const meshObj = obj as THREE.Mesh;
        if (!meshObj.isMesh) return;
        meshObj.userData.transformRoot = plyMesh;
      });
      if (cancelled) {
        disposeObjectTree(plyMesh);
        return;
      }
      attachLoadedMesh(plyMesh, addition.id, addition.url);
    };

    const loadExternalPointPly = async (addition: ExternalSceneAddition) => {
      const loader = new PLYLoader();
      let geometry: THREE.BufferGeometry | null = null;
      try {
        geometry = await tryLoad3dgsBinaryPlyGeometry(addition.url);
      } catch {
        geometry = null;
      }
      if (!geometry) {
        geometry = await loader.loadAsync(addition.url);
      }
      if (!geometry?.getAttribute("position")) {
        throw new Error("PLY points has no position attribute.");
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const hasVertexColors = Boolean(geometry.getAttribute("color"));
      const material = new THREE.PointsMaterial({
        color: hasVertexColors ? 0xffffff : 0xd4d9e8,
        vertexColors: hasVertexColors,
        size: 0.01,
        sizeAttenuation: true
      });
      material.depthTest = true;
      material.depthWrite = true;
      const points = new THREE.Points(geometry, material);
      points.renderOrder = 1;
      if (cancelled) {
        points.geometry.dispose();
        material.dispose();
        return;
      }
      points.name = addition.id;
      points.userData.sourceMeshId = addition.id;
      points.userData.sourceMeshKey = normalizeMeshUrlForDedup(addition.url);
      const handle: SplatHandle = {
        id: `external-${addition.id}`,
        label: points.name,
        object: points,
        runtime: "points",
        sourceKey: normalizeMeshUrlForDedup(addition.url),
        sourceUrl: addition.url,
        formatHint: "ply",
        dispose: () => {
          points.geometry.dispose();
          material.dispose();
        },
        splatCount: geometry.getAttribute("position")?.count ?? 0,
        bounds: geometry.boundingBox?.clone()
      };
      splatHandlesRef.current.add(handle);
      alignmentRoot.add(points);
      refreshSplatItems();
      updateHudFromHandles();
      objectListSelectionAnchorRef.current = buildObjectItemKey("splat", handle.id);
      setSelectedObject(points, "splat");
    };

    const loadExternalSplat = async (addition: ExternalSceneAddition) => {
      const module = (await getGaussianSplatsModule()) as Record<string, unknown>;
      const DropInViewerCtor = module.DropInViewer as
        | (new (options: Record<string, unknown>) => {
            addSplatScene?: (path: string, options?: Record<string, unknown>) => Promise<void>;
            addSplatScenes?: (entries: Array<Record<string, unknown>>) => Promise<void>;
            dispose?: () => void;
            children?: THREE.Object3D[];
          } & THREE.Object3D)
        | undefined;
      if (!DropInViewerCtor) {
        throw new Error("Gaussian splat renderer is unavailable.");
      }
      const sceneFormatEnum = (module.SceneFormat ?? {}) as Record<string, number>;
      const sharedMemoryAllowed = typeof window !== "undefined" && window.crossOriginIsolated === true;
      const object = new DropInViewerCtor({
        selfDrivenMode: false,
        useBuiltInControls: false,
        sharedMemoryForWorkers: sharedMemoryAllowed,
        gpuAcceleratedSort: sharedMemoryAllowed,
        enableSIMDInSort: sharedMemoryAllowed,
        integerBasedSort: false,
        freeIntermediateSplatData: true,
        renderer,
        camera
      });
      object.renderOrder = 1;
      alignmentRoot.add(object);
      const sceneFormat = inferSplatSceneFormat(sceneFormatEnum, addition.url, addition.kind, addition.filename);
      const addOptions: Record<string, unknown> = {
        showLoadingUI: false,
        progressiveLoad: true
      };
      if (sceneFormat !== undefined) addOptions.format = sceneFormat;
      try {
        if (typeof object.addSplatScene === "function") {
          await object.addSplatScene(addition.url, addOptions);
        } else if (typeof object.addSplatScenes === "function") {
          await object.addSplatScenes([{ path: addition.url, ...addOptions }]);
        } else {
          throw new Error("Splat runtime does not support addSplatScene API.");
        }
        if (cancelled) {
          object.parent?.remove(object);
          object.dispose?.();
          return;
        }
        const handle: SplatHandle = {
          id: `external-${addition.id}`,
          label: addition.id,
          object,
          runtime: "legacy",
          sourceKey: normalizeMeshUrlForDedup(addition.url),
          sourceUrl: addition.url,
          formatHint:
            inferSplatSceneFormat(sceneFormatEnum, addition.url, addition.kind, addition.filename) === sceneFormatEnum.Ply
              ? "ply"
              : null,
          dispose: typeof object.dispose === "function" ? () => object.dispose?.() : undefined,
          splatCount: 0
        };
        splatHandlesRef.current.add(handle);
        refreshSplatItems();
        updateHudFromHandles();
        objectListSelectionAnchorRef.current = buildObjectItemKey("splat", handle.id);
        setSelectedObject(object, "splat");
      } catch (error) {
        object.parent?.remove(object);
        object.dispose?.();
        throw error;
      }
    };

    const loadPending = async () => {
      for (const addition of pending) {
        if (cancelled) break;
        try {
          const lowerUrl = addition.url.toLowerCase();
          const lowerKind = addition.kind.toLowerCase();
          if (lowerKind === "mesh_glb" || lowerKind === "mesh_ply" || lowerUrl.endsWith(".glb") || lowerUrl.endsWith(".gltf")) {
            if (lowerKind === "mesh_ply" || urlHasPlyExtension(addition.url)) {
              await loadExternalMeshPly(addition);
            } else {
              await loadExternalMeshGlb(addition);
            }
          } else if (lowerKind === "point_ply") {
            await loadExternalPointPly(addition);
          } else if (lowerKind === "splat_ksplat") {
            await loadExternalSplat(addition);
          } else {
            setRuntimeNotice(`Unsupported external object kind: ${addition.kind}`);
            continue;
          }
          loadedExternalAdditionIdsRef.current.add(addition.id);
          setError(null);
          setTransformDebug(`added external object=${addition.id}`);
        } catch (externalLoadError) {
          const message = externalLoadError instanceof Error ? externalLoadError.message : "Unknown external load error.";
          setError(`Failed to add external object ${addition.id}: ${message}`);
        }
      }
    };

    void loadPending();
    return () => {
      cancelled = true;
    };
  }, [
    externalSceneAdditions,
    loading,
    refreshMeshItems,
    refreshSplatItems,
    setSelectedObject,
    updateHudFromHandles
  ]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#04060d]">
      <div className="absolute left-3 top-3 right-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-black/55 p-2 backdrop-blur-md">
        <DropdownMenu open={toolMenuOpen} onOpenChange={setToolMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="rounded-xl">
              Tool
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Navigation</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setNavMode("orbit")}>
              <Navigation className="mr-2 h-4 w-4" />
              Orbit
              {navMode === "orbit" ? <span className="ml-auto text-[10px] text-zinc-400">Active</span> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNavMode("fly")}>
              <MoveHorizontal className="mr-2 h-4 w-4" />
              Fly
              {navMode === "fly" ? <span className="ml-auto text-[10px] text-zinc-400">Active</span> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={resetCamera}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={fitScene}>
              <Crosshair className="mr-2 h-4 w-4" />
              Fit Scene
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={fitSelection} disabled={!hasActiveSelection}>
              <Crosshair className="mr-2 h-4 w-4" />
              Fit Selection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={captureScreenshot}>
              <Download className="mr-2 h-4 w-4" />
              Screenshot
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open={viewMenuOpen} onOpenChange={setViewMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="rounded-xl">
              View
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Splat Profile</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setSplatLoadProfile("full")}>
              Full Gaussian
              {splatLoadProfile === "full" ? <span className="ml-auto text-[10px] text-zinc-400">Active</span> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSplatLoadProfile("balanced")}>
              Balanced
              {splatLoadProfile === "balanced" ? <span className="ml-auto text-[10px] text-zinc-400">Active</span> : null}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSplatLoadProfile("preview")}>
              Preview
              {splatLoadProfile === "preview" ? <span className="ml-auto text-[10px] text-zinc-400">Active</span> : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setShowGrid((prev) => !prev)}>
              Grid
              <span className="ml-auto text-[10px] text-zinc-400">{showGrid ? "On" : "Off"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setModelviewerAutoRotate((prev) => !prev)}
              disabled={viewMode !== "modelviewer"}
            >
              Modelviewer Auto-Rotate
              <span className="ml-auto text-[10px] text-zinc-400">{modelviewerAutoRotate ? "On" : "Off"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void persistTransforms()} disabled={!isPersistableArtifact}>
              Save Transforms
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="rounded-full border border-border/70 bg-background/40 px-2 py-1 text-[11px] text-zinc-300">
          Runtime: {activeRuntimeLabel} ({configuredRuntimeLabel})
        </div>
        <div className="rounded-full border border-border/70 bg-background/40 px-2 py-1 text-[11px] text-zinc-300">
          Gizmo: {transformMode} ({transformSpace}) • 1/2/3
        </div>
        <div className="ml-auto flex items-center gap-2">
          {fileMenu ? (
            <Button
              size="sm"
              variant={openPanel === "file" ? "default" : "outline"}
              className="rounded-xl"
              onClick={() => setOpenPanel((prev) => (prev === "file" ? "none" : "file"))}
            >
              File
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={openPanel === "settings" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setOpenPanel((prev) => (prev === "settings" ? "none" : "settings"))}
          >
            Settings
          </Button>
          <Button
            size="sm"
            variant={openPanel === "hud" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setOpenPanel((prev) => (prev === "hud" ? "none" : "hud"))}
          >
            HUD
          </Button>
          <Button
            size="sm"
            variant={openPanel === "objects" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setOpenPanel((prev) => (prev === "objects" ? "none" : "objects"))}
          >
            Objects
          </Button>
          <Button
            size="sm"
            variant={openPanel === "transform" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setOpenPanel((prev) => (prev === "transform" ? "none" : "transform"))}
          >
            Transform
          </Button>
        </div>
      </div>

      {openPanel === "file" && fileMenu ? (
        <div className="absolute right-3 top-16 z-30 w-[360px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300">File</div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
            {fileMenu.selectedKind ? (
              <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-zinc-200">
                {fileMenu.selectedKind}
              </span>
            ) : null}
            {fileMenu.activeNodeScope ? (
              <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-zinc-200">
                Node {fileMenu.activeNodeScope}
              </span>
            ) : null}
            {fileMenu.rendererLabel ? (
              <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-zinc-200">
                {fileMenu.rendererLabel}
              </span>
            ) : null}
          </div>
          <div className="mb-2 truncate text-xs text-zinc-400">{fileMenu.selectedArtifactText}</div>
          <div className="mb-2">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Bundle Mode</div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant={fileMenu.bundleMode === "same_node" ? "default" : "outline"}
                className="h-8 rounded-md text-xs"
                onClick={() => fileMenu.onBundleModeChange?.("same_node")}
              >
                Same Node
              </Button>
              <Button
                size="sm"
                variant={fileMenu.bundleMode === "project_fallback" ? "default" : "outline"}
                className="h-8 rounded-md text-xs"
                onClick={() => fileMenu.onBundleModeChange?.("project_fallback")}
              >
                Project Fallback
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" className="h-8 rounded-md text-xs" onClick={fileMenu.onPickLocalFile}>
              Open local file
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-md text-xs"
              onClick={() => fileMenu.onAddExternalFile?.()}
              disabled={!fileMenu.onAddExternalFile}
            >
              Add external object
            </Button>
            {fileMenu.canUseRunArtifact ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-md text-xs"
                onClick={() => fileMenu.onUseRunArtifact?.()}
              >
                Use run artifact
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-8 rounded-md text-xs" disabled>
                Use run artifact
              </Button>
            )}
            {fileMenu.canBuildTileset ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-md text-xs col-span-2"
                onClick={() => fileMenu.onBuildTileset?.()}
                disabled={fileMenu.buildTilesetLoading}
              >
                {fileMenu.buildTilesetLoading ? "Building tileset..." : "Build Tileset"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-md text-xs col-span-2"
              onClick={() => fileMenu.onClearScene?.()}
            >
              Clear Scene
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-md text-xs col-span-2"
              onClick={() => fileMenu.onResetViewer?.()}
            >
              Reset Viewer
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
            <span>Source: {fileMenu.sourceLabel}</span>
            <span>•</span>
            <span>Viewer: {fileMenu.viewerLabel}</span>
          </div>
          {fileMenu.bundleSourceNote ? (
            <div className="mt-1 text-[11px] text-zinc-400">Bundle: {fileMenu.bundleSourceNote}</div>
          ) : null}
          {fileMenu.options.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Select Artifact</div>
              <div className="max-h-[220px] space-y-1 overflow-auto pr-1">
                {fileMenu.options.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={option.selected ? "default" : "outline"}
                    className="h-8 w-full justify-start gap-2 rounded-md text-left"
                    onClick={() => {
                      setArtifactContextMenu(null);
                      window.location.assign(option.href);
                    }}
                    onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      const menuWidth = 184;
                      const menuHeight = 82;
                      const maxX = typeof window !== "undefined" ? window.innerWidth - menuWidth - 8 : event.clientX;
                      const maxY = typeof window !== "undefined" ? window.innerHeight - menuHeight - 8 : event.clientY;
                      setArtifactContextMenu({
                        x: Math.max(8, Math.min(event.clientX, maxX)),
                        y: Math.max(8, Math.min(event.clientY, maxY)),
                        artifactId: option.id,
                        label: option.label
                      });
                    }}
                    disabled={fileMenu.deletingArtifactId === option.id}
                  >
                    <span className="shrink-0 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px]">
                      {option.kind}
                    </span>
                    <span className="truncate text-[11px]">{option.label}</span>
                  </Button>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-zinc-500">Right-click artifact for delete action.</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {openPanel === "settings" ? (
        <div className="absolute left-3 bottom-3 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-zinc-300">Settings</p>
          <div className="mb-3 rounded-md border border-border/50 bg-background/20 p-1.5">
            <p className="mb-1 text-xs uppercase tracking-[0.14em] text-zinc-400">View Mode</p>
            <div className="grid grid-cols-2 gap-1">
              <Button
                size="sm"
                variant={viewMode === "default" ? "default" : "outline"}
                className="h-7 rounded-md text-xs"
                onClick={() => switchViewMode("default")}
              >
                Default
              </Button>
              <Button
                size="sm"
                variant={viewMode === "modelviewer" ? "default" : "outline"}
                className="h-7 rounded-md text-xs"
                onClick={() => switchViewMode("modelviewer")}
              >
                Modelviewer
              </Button>
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">
              Modelviewer: FOV 75, fixed near/far, origin camera, fly nav, slow scene spin.
            </p>
          </div>
          <p className="mb-2 text-xs uppercase tracking-[0.14em] text-zinc-400">Fly Speed</p>
          <Slider min={1} max={20} step={0.5} value={flySpeed} onValueChange={setFlySpeed} />
          <p className="mt-2 text-xs text-zinc-400">
            {flySpeed[0].toFixed(1)} u/s {navMode === "fly" ? "• Shift boost x3" : ""}
          </p>
          <div className="mt-3 border-t border-border/50 pt-3">
            <p className="mb-2 text-xs uppercase tracking-[0.14em] text-zinc-400">Splat Density</p>
            <Slider
              min={1}
              max={100}
              step={1}
              value={splatDensityDraft}
              onValueChange={setSplatDensityDraft}
              onValueCommit={(values) => setSplatDensityApplied(values[0] ?? 100)}
            />
            <p className="mt-2 text-xs text-zinc-400">
              {Math.round(splatDensityDraft[0] ?? 100)}% requested • {Math.round(splatDensityApplied)}% applied
            </p>
          </div>
          <div className="mt-3 border-t border-border/50 pt-3">
            <p className="mb-2 text-xs uppercase tracking-[0.14em] text-zinc-400">Environment HDRI</p>
            <Input
              className="h-8 rounded-md border-border/60 bg-background/50 px-2 text-xs"
              placeholder="https://.../studio.hdr or studio.exr"
              value={hdriUrlDraft}
              onChange={(event) => setHdriUrlDraft(event.target.value)}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                applyHdriUrlDraft();
              }}
            />
            <div className="mt-2 grid grid-cols-3 gap-1">
              <Button size="sm" className="h-7 rounded-md text-xs" onClick={applyHdriUrlDraft}>
                Apply URL
              </Button>
              <Button size="sm" variant="outline" className="h-7 rounded-md text-xs" onClick={pickLocalHdri}>
                Open .hdr
              </Button>
              <Button size="sm" variant="outline" className="h-7 rounded-md text-xs" onClick={clearHdriEnvironment}>
                Clear
              </Button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1">
              <Button
                size="sm"
                variant={viewerEnvironment.enabled ? "default" : "outline"}
                className="h-7 rounded-md text-xs"
                onClick={() =>
                  setViewerEnvironment((current) =>
                    normalizeEnvironmentConfig({
                      ...current,
                      enabled: !current.enabled
                    })
                  )
                }
              >
                {viewerEnvironment.enabled ? "HDRI On" : "HDRI Off"}
              </Button>
              <Button
                size="sm"
                variant={viewerEnvironment.backgroundMode === "hdri" ? "default" : "outline"}
                className="h-7 rounded-md text-xs"
                onClick={() =>
                  setViewerEnvironment((current) =>
                    normalizeEnvironmentConfig({
                      ...current,
                      backgroundMode: current.backgroundMode === "hdri" ? "solid" : "hdri"
                    })
                  )
                }
              >
                BG {viewerEnvironment.backgroundMode === "hdri" ? "HDRI" : "Solid"}
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              Use `.hdr` or `.exr` files. URL must be reachable from browser (CORS).
            </p>
          </div>
        </div>
      ) : null}

      {openPanel === "hud" ? (
        <div className="absolute right-3 top-16 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 text-xs text-zinc-200 backdrop-blur-md">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300">HUD</div>
          <div className="mt-2 space-y-1">
            <div>FPS: {fps}</div>
            <div>Triangles: {rendererRef.current?.info.render.triangles ?? 0}</div>
            <div>Draw calls: {rendererRef.current?.info.render.calls ?? 0}</div>
            <div>
              Scene bundle: {meshItems.length}/{manifest.meshes.length} meshes • {splatItems.length}/
              {directSplats.length} splats
            </div>
            <div>Loaded tiles: {hud.loadedTiles}</div>
            <div>Loaded splats: {hud.loadedSplats.toLocaleString()}</div>
            <div>Loaded MB: {hud.loadedMB.toFixed(1)}</div>
            <div>Splat runtime: {activeRuntimeLabel}</div>
            <div>Runtime policy: {configuredRuntimeLabel}</div>
            <div>
              LOD: {hud.activeLodDistribution["0"]}/{hud.activeLodDistribution["1"]}/{hud.activeLodDistribution["2"]}
            </div>
            <div>
              Selected: {selectedName ?? "none"}
              {selectedKind ? ` (${selectedKind})` : ""}
            </div>
          </div>
        </div>
      ) : null}

      {openPanel === "objects" ? (
        <div className="absolute right-3 top-16 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300">Objects</div>
          <div className="mb-2 rounded-md border border-border/50 bg-background/20 p-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Grouping</div>
            <div className="mb-1 text-[11px] text-zinc-300">
              Marked: {markedGroupMembers.length}
              {activeGroupMeta ? ` • ${activeGroupMeta.name} (${activeGroupMeta.memberCount})` : ""}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={createGroupFromMarkedSelection}
                disabled={!canCreateGroup}
              >
                Create Group
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={selectActiveGroup}
                disabled={!canSelectExistingGroup}
              >
                Select Group
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={() => ungroupActiveSelection(false)}
                disabled={!canSelectExistingGroup}
              >
                Ungroup
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={clearMarkedGroupSelection}
                disabled={groupSelectionKeys.length === 0}
              >
                Clear Marks
              </Button>
            </div>
          </div>
          <div className="max-h-[280px] space-y-1 overflow-auto pr-1">
            {objectItems.length === 0 ? (
              <div className="rounded-md border border-border/50 px-2 py-1 text-xs text-zinc-400">No scene objects</div>
            ) : (
              objectItems.map((item) => (
                <div key={item.id} className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={
                      (selectedKind !== "group" && selectedName === item.id) ||
                      groupSelectionSet.has(buildObjectItemKey(item.kind, item.id))
                        ? "default"
                        : "outline"
                    }
                    className="h-8 flex-1 justify-between gap-2 rounded-md"
                    onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                      const itemKey = buildObjectItemKey(item.kind, item.id);
                      if (event.shiftKey) {
                        if (item.kind !== "mesh") {
                          objectListSelectionAnchorRef.current = itemKey;
                          selectObjectItem(item.kind, item.id);
                          return;
                        }
                        selectObjectRangeFromAnchor(itemKey);
                        selectObjectItem(item.kind, item.id);
                        return;
                      }
                      if (event.metaKey || event.ctrlKey) {
                        toggleObjectMarkedForGroup(item.kind, item.id);
                        selectObjectItem(item.kind, item.id);
                        return;
                      }
                      objectListSelectionAnchorRef.current = itemKey;
                      selectObjectItem(item.kind, item.id);
                    }}
                    onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      selectObjectItem(item.kind, item.id);
                      const menuWidth = 168;
                      const menuHeight = 78;
                      const maxX = typeof window !== "undefined" ? window.innerWidth - menuWidth - 8 : event.clientX;
                      const maxY = typeof window !== "undefined" ? window.innerHeight - menuHeight - 8 : event.clientY;
                      setObjectContextMenu({
                        x: Math.max(8, Math.min(event.clientX, maxX)),
                        y: Math.max(8, Math.min(event.clientY, maxY)),
                        itemId: item.id,
                        kind: item.kind,
                        label: item.label
                      });
                    }}
                  >
                    <span className="truncate text-left text-xs">{item.label}</span>
                    <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px]">
                      {item.kind === "mesh" ? "mesh" : "splat"}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant={groupSelectionSet.has(buildObjectItemKey(item.kind, item.id)) ? "default" : "outline"}
                    className="h-8 w-8 rounded-md px-0 text-[11px]"
                    onClick={() => toggleObjectMarkedForGroup(item.kind, item.id)}
                    title="Mark for grouping"
                    disabled={item.kind !== "mesh"}
                  >
                    G
                  </Button>
                </div>
              ))
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-8 w-full rounded-md text-xs"
            onClick={() => setOpenPanel("transform")}
            disabled={!hasActiveSelection}
          >
            Open Transform
          </Button>
          <div className="mt-1 text-[10px] text-zinc-500">
            Meshes and splats are editable with gizmo. Shift+drag in viewer for mesh box select.
          </div>
        </div>
      ) : null}

      {objectContextMenu ? (
        <div
          ref={objectContextMenuRef}
          className="fixed z-[120] w-[168px] rounded-md border border-border/70 bg-[#090d18]/95 p-1.5 shadow-lg backdrop-blur-md"
          style={{ left: objectContextMenu.x, top: objectContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="mb-1 truncate px-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">
            {objectContextMenu.kind}
          </div>
          <div className="mb-1 truncate px-1 text-[11px] text-zinc-300">{objectContextMenu.label}</div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full justify-start rounded-md px-2 text-xs"
            onClick={() => removeObjectItem(objectContextMenu.kind, objectContextMenu.itemId)}
          >
            Delete From Scene
          </Button>
        </div>
      ) : null}

      {artifactContextMenu ? (
        <div
          ref={artifactContextMenuRef}
          className="fixed z-[120] w-[184px] rounded-md border border-border/70 bg-[#090d18]/95 p-1.5 shadow-lg backdrop-blur-md"
          style={{ left: artifactContextMenu.x, top: artifactContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="mb-1 truncate px-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">artifact</div>
          <div className="mb-1 truncate px-1 text-[11px] text-zinc-300">{artifactContextMenu.label}</div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full justify-start rounded-md px-2 text-xs"
            onClick={() => {
              fileMenu?.onDeleteArtifact?.(artifactContextMenu.artifactId, artifactContextMenu.label);
              setArtifactContextMenu(null);
            }}
            disabled={!fileMenu?.onDeleteArtifact || fileMenu.deletingArtifactId === artifactContextMenu.artifactId}
          >
            {fileMenu?.deletingArtifactId === artifactContextMenu.artifactId ? "Deleting..." : "Delete Artifact"}
          </Button>
        </div>
      ) : null}

      {openPanel === "transform" ? (
        <div className="absolute right-3 top-16 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300">Transform</div>
          <div className="mb-2 rounded-md border border-border/50 bg-background/20 p-1.5">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Scene Alignment</div>
            <div className="grid grid-cols-2 gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={() => {
                  void autoAlignSceneToGroundPlane(true, false);
                }}
              >
                Auto Align Scene
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs"
                onClick={() => {
                  void autoAlignSceneToGroundPlane(true, true);
                }}
                disabled={!canAutoAlignSelected}
              >
                Auto Align Selected
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 rounded-md text-xs col-span-2"
                onClick={() => resetSceneAlignment(true)}
              >
                Reset Scene Align
              </Button>
              <Button
                size="sm"
                variant={groundAlignDebug ? "default" : "outline"}
                className="h-7 rounded-md text-xs col-span-2"
                onClick={() => setGroundAlignDebug((prev) => !prev)}
              >
                Debug Overlay: {groundAlignDebug ? "On" : "Off"}
              </Button>
            </div>
          </div>
          {selectedKind && transformDraft ? (
            <div className="space-y-2">
              <div className="rounded-md border border-border/50 bg-background/20 p-1.5">
                <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Environment Transform</div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full rounded-md text-xs"
                  onClick={applySelectedAxisCorrection}
                  disabled={!hasActiveSelection}
                >
                  Correct Axis Misalignment
                </Button>
              </div>
              <div className="rounded-md border border-border/50 bg-background/20 p-1.5">
                <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">Step</div>
                <div className="grid grid-cols-3 gap-1">
                  {TRANSFORM_STEP_OPTIONS.map((step) => (
                    <Button
                      key={`transform-step-${step}`}
                      type="button"
                      size="sm"
                      variant={transformStep === step ? "default" : "outline"}
                      className="h-6 rounded-md px-2 text-[11px]"
                      onClick={() => setTransformStep(step)}
                    >
                      {step}
                    </Button>
                  ))}
                </div>
              </div>
              {(["position", "rotation", "scale"] as const).map((section) => (
                <div key={section}>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-zinc-400">{section}</div>
                  <div className="grid grid-cols-3 gap-1">
                    {([0, 1, 2] as const).map((axisIndex) => (
                      <div key={`${section}-${axisIndex}`} className="grid grid-cols-[1fr_auto] gap-1">
                        <Input
                          className="h-7 min-w-0 rounded-md border-border/60 bg-background/50 px-2 text-xs"
                          value={transformDraft[section][axisIndex]}
                          onChange={(event) =>
                            updateTransformDraftValue(section, axisIndex, event.target.value)
                          }
                          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            applyTransformDraft();
                          }}
                          onMouseDownCapture={(event: ReactMouseEvent<HTMLInputElement>) => {
                            if (event.button === 1) {
                              event.preventDefault();
                              event.stopPropagation();
                            }
                          }}
                        />
                        <div className="grid grid-rows-2 gap-0.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-[13px] w-6 rounded-[6px] px-0 text-[10px] leading-none"
                            onClick={() => nudgeTransformDraftValue(section, axisIndex, 1)}
                          >
                            +
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-[13px] w-6 rounded-[6px] px-0 text-[10px] leading-none"
                            onClick={() => nudgeTransformDraftValue(section, axisIndex, -1)}
                          >
                            -
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-1">
                <Button size="sm" className="h-7 rounded-md text-xs" onClick={applyTransformDraft}>
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md text-xs"
                  onClick={resetSelectedTransform}
                  disabled={!hasActiveSelection}
                >
                  Reset Transform
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md text-xs col-span-2"
                  onClick={fitSelection}
                  disabled={!hasActiveSelection}
                >
                  Focus
                </Button>
              </div>
              <div className="rounded-md border border-border/50 bg-background/20 p-1 text-[10px] text-zinc-400">
                {transformDebug}
              </div>
              {selectedKind === "splat" ? (
                <div className="text-[11px] text-zinc-400">Editing splat transform</div>
              ) : null}
              {selectedKind === "group" && activeGroupMeta ? (
                <div className="text-[11px] text-zinc-400">
                  Editing {activeGroupMeta.name} ({activeGroupMeta.memberCount} objects)
                </div>
              ) : null}
              {isPersistableArtifact ? (
                <div className="text-[11px] text-zinc-400">
                  Transforms: {persistState}
                  {persistMessage ? ` • ${persistMessage}` : ""}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] text-zinc-500">Select an object to edit transform.</div>
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="absolute left-3 top-20 z-30 rounded-xl border border-border/70 bg-black/50 px-3 py-2 text-sm text-zinc-200 backdrop-blur-sm">
          Loading world...
        </div>
      ) : null}
      {error ? (
        <div className={cn("absolute left-3 top-20 z-30 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200")}>
          {error}
        </div>
      ) : null}
      {runtimeNotice ? (
        <div
          className={cn(
            "absolute left-3 top-32 z-30 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
          )}
        >
          {runtimeNotice}
        </div>
      ) : null}

      {dragSelectionRect ? (
        <div
          className="pointer-events-none absolute z-[22] border border-sky-400/80 bg-sky-400/15"
          style={{
            left: dragSelectionRect.x,
            top: dragSelectionRect.y,
            width: dragSelectionRect.width,
            height: dragSelectionRect.height
          }}
        />
      ) : null}

      <input
        ref={hdriFileInputRef}
        type="file"
        accept=".hdr,.HDR,.pic,.PIC,.exr,.EXR,image/vnd.radiance,image/x-exr"
        className="hidden"
        onChange={onHdriFilePicked}
      />

      <div ref={containerRef} className="h-full w-full" />

      <div className="pointer-events-none absolute bottom-3 right-3 z-20 rounded-lg border border-white/10 bg-black/55 px-2 py-1 text-[11px] text-zinc-300">
        <Camera className="mr-1 inline h-3.5 w-3.5" />
        Unified viewer
      </div>
    </div>
  );
}
