"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { Camera, Crosshair, Download, MoveHorizontal, Navigation, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { getSplatRuntimePreference, isSparkRuntimeEnabled } from "@/lib/viewer/splat-runtime-config";
import { cn } from "@/lib/utils";

interface WorldManifest {
  artifactId?: string;
  camera?: {
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
  };
  meshes: Array<{ id: string; url: string }>;
  splats: Array<{
    id: string;
    tilesetUrl: string | null;
    sourceUrl: string | null;
    formatHint?: "ply" | "splat" | "ksplat" | "spz" | null;
  }>;
}

type NavigationMode = "orbit" | "fly";
type SplatLoadProfile = "full" | "balanced" | "preview";
type FloatingPanel = "none" | "file" | "settings" | "hud" | "objects" | "transform";
type BundleMode = "same_node" | "project_fallback";
type SplatRuntimeName = "legacy" | "spark";
type LoadedSplatRuntime = SplatRuntimeName | "points";

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
  onUseRunArtifact?: () => void;
  onBuildTileset?: () => void;
  onBundleModeChange?: (mode: BundleMode) => void;
  onResetViewer?: () => void;
}

interface MeshTransformRecord {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface PersistedViewerTransforms {
  meshes: Record<string, MeshTransformRecord>;
  splats: Record<string, MeshTransformRecord>;
}

interface MeshListItem {
  id: string;
  label: string;
}

type SceneObjectKind = "mesh" | "splat";

interface SplatListItem {
  id: string;
  label: string;
  splatCount: number;
}

interface TransformDraft {
  position: [string, string, string];
  rotation: [string, string, string];
  scale: [string, string, string];
}

interface SplatHandle {
  id: string;
  label: string;
  object: THREE.Object3D;
  runtime: LoadedSplatRuntime;
  dispose?: () => void;
  update?: () => void;
  splatCount?: number;
  bounds?: THREE.Box3;
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

interface ParsedPlyHeader {
  vertexCount: number;
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

  const parsedProperties = lines
    .filter((line) => line.startsWith("property "))
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : "";
    })
    .filter(Boolean);

  return {
    vertexCount,
    dataOffset: endMatch.index + endMatch[0].length,
    format,
    properties: parsedProperties
  };
}

function parse3dgsHeader(rawHeader: string): { vertexCount: number; dataOffset: number } | null {
  const parsed = parsePlyHeader(rawHeader);
  if (!parsed) return null;
  if (parsed.format !== "binary_little_endian 1.0") return null;

  const expectedProperties = PLY_3DGS_PROPERTIES.map((name) => `float:${name}`);
  if (parsed.properties.length !== expectedProperties.length) return null;
  for (let i = 0; i < expectedProperties.length; i += 1) {
    if (parsed.properties[i] !== expectedProperties[i]) return null;
  }

  return { vertexCount: parsed.vertexCount, dataOffset: parsed.dataOffset };
}

async function inspectPlyUrl(url: string): Promise<{ vertexCount: number; is3dgs: boolean } | null> {
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
    return { vertexCount: parsed.vertexCount, is3dgs };
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
      return `${parsed.origin}${parsed.pathname}?key=${keyParam}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
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
  fileMenu
}: {
  manifest: WorldManifest;
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
  const meshRootsRef = useRef<THREE.Object3D[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const keysRef = useRef<Set<string>>(new Set());
  const splatHandlesRef = useRef(new Set<SplatHandle>());
  const tempBlobUrlsRef = useRef<string[]>([]);
  const hudRef = useRef<ViewerHudStats>(DEFAULT_STATS);
  const fpsCounterRef = useRef({ acc: 0, frames: 0, fps: 0 });
  const pausedRef = useRef(false);
  const navModeRef = useRef<NavigationMode>("orbit");
  const flySpeedRef = useRef(4);

  const [navMode, setNavMode] = useState<NavigationMode>("orbit");
  const [flySpeed, setFlySpeed] = useState([4]);
  const [splatLoadProfile, setSplatLoadProfile] = useState<SplatLoadProfile>("full");
  const [splatDensityDraft, setSplatDensityDraft] = useState([100]);
  const [splatDensityApplied, setSplatDensityApplied] = useState(100);
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

  useEffect(() => {
    navModeRef.current = navMode;
  }, [navMode]);

  useEffect(() => {
    flySpeedRef.current = flySpeed[0] ?? 4;
  }, [flySpeed]);

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
    const euler = new THREE.Euler().setFromQuaternion(object.quaternion, "XYZ");
    const world = new THREE.Vector3();
    object.getWorldPosition(world);
    setTransformDraft({
      position: [
        object.position.x.toFixed(3),
        object.position.y.toFixed(3),
        object.position.z.toFixed(3)
      ],
      rotation: [
        THREE.MathUtils.radToDeg(euler.x).toFixed(2),
        THREE.MathUtils.radToDeg(euler.y).toFixed(2),
        THREE.MathUtils.radToDeg(euler.z).toFixed(2)
      ],
      scale: [object.scale.x.toFixed(3), object.scale.y.toFixed(3), object.scale.z.toFixed(3)]
    });
    setTransformDebug(
      `selected=${object.name || object.uuid} local=(${object.position.x.toFixed(3)}, ${object.position.y.toFixed(
        3
      )}, ${object.position.z.toFixed(3)}) world=(${world.x.toFixed(3)}, ${world.y.toFixed(3)}, ${world.z.toFixed(3)})`
    );
  }, []);

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
          splats: serializeSplatTransforms()
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
  }, [isPersistableArtifact, manifest.artifactId, serializeMeshTransforms, serializeSplatTransforms]);

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

  const loadPersistedTransforms = useCallback(async (): Promise<PersistedViewerTransforms> => {
    if (!isPersistableArtifact || !manifest.artifactId) return { meshes: {}, splats: {} };
    try {
      const response = await fetch(`/api/world/transforms?artifactId=${encodeURIComponent(manifest.artifactId)}`, {
        cache: "no-store"
      });
      if (!response.ok) return { meshes: {}, splats: {} };
      const payload = (await response.json()) as {
        payload?: {
          meshes?: Record<string, MeshTransformRecord>;
          splats?: Record<string, MeshTransformRecord>;
        };
      };
      return {
        meshes: payload.payload?.meshes ?? {},
        splats: payload.payload?.splats ?? {}
      };
    } catch {
      return { meshes: {}, splats: {} };
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

  const setSelectedObject = useCallback((object: THREE.Object3D | null, kind: SceneObjectKind | null = null) => {
    selectedRef.current = object;
    const splatHandle = object
      ? [...splatHandlesRef.current].find((handle) => handle.object === object) ?? null
      : null;
    const resolvedKind: SceneObjectKind | null = object
      ? kind ??
        (meshRootsRef.current.includes(object)
          ? "mesh"
          : splatHandle
            ? "splat"
            : null)
      : null;
    setSelectedKind(resolvedKind);
    setSelectedName(
      object
        ? resolvedKind === "splat"
          ? (splatHandle?.id ?? object.name ?? object.uuid)
          : object.name || object.uuid
        : null
    );
    const scene = sceneRef.current;
    clearSelectedHelper();
    const attachMeshSelectionBox = (target: THREE.Object3D) => {
      target.updateMatrixWorld(true);
      const box = new THREE.BoxHelper(target, 0x34d399);
      box.renderOrder = 9998;
      const boxMaterial = box.material as THREE.Material;
      boxMaterial.depthTest = false;
      boxMaterial.depthWrite = false;
      boxMaterial.transparent = true;
      boxMaterial.opacity = 0.95;
      if (scene) scene.add(box);
      selectedBoxRef.current = box;
    };
    const attachSplatSelectionBox = (target: THREE.Object3D, bounds?: THREE.Box3) => {
      target.updateMatrixWorld(true);
      const box = bounds?.clone().applyMatrix4(target.matrixWorld) ?? new THREE.Box3().setFromObject(target);
      if (box.isEmpty()) return;
      const helper = new THREE.Box3Helper(box, 0x34d399);
      helper.renderOrder = 9998;
      const helperMaterial = helper.material as THREE.Material;
      helperMaterial.depthTest = false;
      helperMaterial.depthWrite = false;
      helperMaterial.transparent = true;
      helperMaterial.opacity = 0.95;
      if (scene) scene.add(helper);
      selectedBoxRef.current = helper;
    };
    if (object && resolvedKind === "mesh") {
      object.traverse((node: THREE.Object3D) => {
        node.matrixAutoUpdate = true;
      });
      attachMeshSelectionBox(object);
      syncTransformDraft(object);
      return;
    }
    if (object && resolvedKind === "splat") {
      attachSplatSelectionBox(object, splatHandle?.bounds);
      syncTransformDraft(object);
      return;
    }
    setTransformDraft(null);
    setTransformDebug("No object selected");
  }, [clearSelectedHelper, syncTransformDraft]);

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

  const applyTransformFromDraft = useCallback(
    (draft: TransformDraft, commit: boolean) => {
      const object = resolveSelectedObject();
      if (!object) return false;

      const read = (value: string, fallback: number) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      const px = read(draft.position[0], object.position.x);
      const py = read(draft.position[1], object.position.y);
      const pz = read(draft.position[2], object.position.z);
      const rx = read(draft.rotation[0], THREE.MathUtils.radToDeg(object.rotation.x));
      const ry = read(draft.rotation[1], THREE.MathUtils.radToDeg(object.rotation.y));
      const rz = read(draft.rotation[2], THREE.MathUtils.radToDeg(object.rotation.z));
      const sx = read(draft.scale[0], object.scale.x);
      const sy = read(draft.scale[1], object.scale.y);
      const sz = read(draft.scale[2], object.scale.z);

      object.position.set(px, py, pz);
      object.rotation.set(
        THREE.MathUtils.degToRad(rx),
        THREE.MathUtils.degToRad(ry),
        THREE.MathUtils.degToRad(rz),
        "XYZ"
      );
      object.scale.set(sx, sy, sz);
      object.updateWorldMatrix(true, true);
      sceneRef.current?.updateMatrixWorld(true);

      if (commit) {
        schedulePersist();
        setTransformDebug(`apply id=${object.name || object.uuid} pos=(${px.toFixed(3)},${py.toFixed(3)},${pz.toFixed(3)})`);
        setSelectedObject(object, selectedKind);
      } else {
        syncLiveSplatSelectionBox();
      }
      return true;
    },
    [resolveSelectedObject, schedulePersist, selectedKind, setSelectedObject, syncLiveSplatSelectionBox]
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

    schedulePersist();
    setTransformDebug(`reset id=${object.name || object.uuid} -> identity transform`);
    setSelectedObject(object, selectedKind);
  }, [schedulePersist, selectedKind, selectedName, setSelectedObject]);

  const fitScene = useCallback(() => {
    const root = rootRef.current;
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

  const resetCamera = useCallback(() => {
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!camera || !orbit) return;

    const preset = manifest.camera;
    const position = preset?.position ?? [4, 3, 4];
    const target = preset?.target ?? [0, 0, 0];

    camera.position.set(position[0], position[1], position[2]);
    orbit.target.set(target[0], target[1], target[2]);
    orbit.update();
  }, [manifest.camera]);

  const fitSelection = useCallback(() => {
    const selected = selectedRef.current;
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!selected || !camera || !orbit) return;

    const box = new THREE.Box3().setFromObject(selected);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const distance = maxDim * 2.2;
    camera.position.copy(center.clone().add(new THREE.Vector3(distance, distance * 0.6, distance)));
    orbit.target.copy(center);
    orbit.update();
  }, []);

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

    let disposed = false;
    let cancelled = false;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#05070e");
    sceneRef.current = scene;
    meshRootsRef.current = [];
    setMeshItems([]);
    setSplatItems([]);
    setActiveSplatRuntimes([]);
    setRuntimeNotice(null);
    setSelectedObject(null);

    const root = new THREE.Group();
    root.name = "WorldRoot";
    scene.add(root);
    rootRef.current = root;

    const camera = new THREE.PerspectiveCamera(
      manifest.camera?.fov ?? 50,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.0001,
      4000
    );
    camera.position.set(...(manifest.camera?.position ?? [4, 3, 4]));
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x101828, 1.1);
    hemi.position.set(0, 30, 0);
    scene.add(hemi);

    const directional = new THREE.DirectionalLight(0xffffff, 1.2);
    directional.position.set(8, 12, 6);
    scene.add(directional);

    scene.add(new THREE.GridHelper(24, 48, 0x263245, 0x111827));

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.07;
    orbit.zoomSpeed = 0.35;
    orbit.target.set(...(manifest.camera?.target ?? [0, 0, 0]));
    orbit.update();
    orbitRef.current = orbit;

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
      keysRef.current.add(event.code);
      if (event.code === "Delete" || event.code === "Backspace") {
        if (selectedRef.current) {
          setSelectedObject(null);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onPointerDown = (event: PointerEvent) => {
      if (!rendererRef.current || !cameraRef.current) return;
      const rect = rendererRef.current.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, cameraRef.current);

      const intersections = raycaster.intersectObjects(meshRootsRef.current, true);
      if (intersections.length === 0) {
        return;
      }

      const hit = intersections[0]?.object;
      if (!hit) {
        return;
      }

      let current: THREE.Object3D | null = hit;
      let selected: THREE.Object3D | null = hit;
      while (current) {
        if (meshRootsRef.current.includes(current)) {
          selected = current;
          break;
        }
        current = current.parent;
      }
      setSelectedObject(selected, "mesh");
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const width = Math.max(1, containerRef.current.clientWidth);
      const height = Math.max(1, containerRef.current.clientHeight);
      rendererRef.current.setSize(width, height);
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
      root.add(object);
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
        root.remove(object);
        object.dispose?.();
        throw error;
      }

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object,
        runtime: "legacy",
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
      root.add(object);
      try {
        await waitForSparkSplatReady(instance);
        const bridge = await ensureSparkRendererBridge();
        if (!bridge) {
          throw new Error("SparkRenderer is not available in this environment.");
        }
      } catch (error) {
        root.remove(object);
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
      root.add(points);

      const handle: SplatHandle = {
        id: buildSplatHandleId(idSource ?? url),
        label: buildSplatLabel(idSource ?? url),
        object: points,
        runtime: "points",
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
      const is3dgs = Boolean(inspected?.is3dgs);
      const vertexCount = inspected?.vertexCount ?? 0;
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
        if (disposed || cancelled) return;

        const meshIdUsage = new Map<string, number>();
        const meshLoadErrors: string[] = [];
        const dedupedMeshes = (manifest.meshes ?? []).filter((mesh, index, source) => {
          const key = normalizeMeshUrlForDedup(mesh.url);
          return source.findIndex((candidate) => normalizeMeshUrlForDedup(candidate.url) === key) === index;
        });

        for (const mesh of dedupedMeshes) {
          if (disposed || cancelled) break;
          try {
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
            gltf.scene.renderOrder = 0;

            const baseId = mesh.id || gltf.scene.name || "mesh";
            const usageCount = meshIdUsage.get(baseId) ?? 0;
            meshIdUsage.set(baseId, usageCount + 1);
            gltf.scene.name = usageCount === 0 ? baseId : `${baseId}-${usageCount}`;

            meshRootsRef.current.push(gltf.scene);
            root.add(gltf.scene);
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
          setPersistMessage("Loaded saved transforms");
        }
        if (meshLoadErrors.length > 0) {
          setError(
            `Loaded ${meshRootsRef.current.length}/${manifest.meshes.length} meshes. Failed: ${meshLoadErrors.join(" | ")}`
          );
        }

        if (directSplats.length > 0) {
          for (const splatEntry of directSplats) {
            if (disposed || cancelled) break;
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
        fitScene();
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

      if (navModeRef.current === "orbit") {
        orbit.enabled = true;
        orbit.update();
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

      for (const handle of [...splatHandlesRef.current]) {
        if (!handle.update) continue;
        try {
          handle.update();
        } catch (updateError) {
          splatHandlesRef.current.delete(handle);
          root.remove(handle.object);
          handle.dispose?.();
          refreshSplatItems();
          const message =
            updateError instanceof Error ? updateError.message : "Splat renderer update failed.";
          setError(`Splat update failed: ${message}`);
        }
      }
      if (selectedBoxRef.current instanceof THREE.BoxHelper) {
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
      renderer.render(scene, camera);

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
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
        requestRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      resizeObserver.disconnect();

      setSelectedObject(null);
      clearSelectedHelper();

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

      disposeObjectTree(root);
      scene.clear();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, [
    applyMeshTransforms,
    directSplats,
    fitScene,
    isPersistableArtifact,
    loadPersistedTransforms,
    manifest,
    refreshMeshItems,
    refreshSplatItems,
    schedulePersist,
    clearSelectedHelper,
    setSelectedObject,
    preferredRuntimeOrder,
    splatLoadProfile,
    splatDensityApplied,
    updateHudFromHandles
  ]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#04060d]">
      <div className="absolute left-3 top-3 right-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-black/55 p-2 backdrop-blur-md">
        <Button size="sm" variant={navMode === "orbit" ? "default" : "outline"} className="rounded-xl" onClick={() => setNavMode("orbit")}>
          <Navigation className="mr-1 h-4 w-4" />
          Orbit
        </Button>
        <Button size="sm" variant={navMode === "fly" ? "default" : "outline"} className="rounded-xl" onClick={() => setNavMode("fly")}>
          <MoveHorizontal className="mr-1 h-4 w-4" />
          Fly
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={resetCamera}>
          <RotateCcw className="mr-1 h-4 w-4" />
          Reset
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={fitScene}>
          <Crosshair className="mr-1 h-4 w-4" />
          Fit Scene
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={fitSelection} disabled={!selectedRef.current}>
          <Crosshair className="mr-1 h-4 w-4" />
          Fit Selection
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={captureScreenshot}>
          <Download className="mr-1 h-4 w-4" />
          Screenshot
        </Button>
        <div className="ml-1 h-6 w-px bg-border/60" />
        <Button
          size="sm"
          variant={splatLoadProfile === "full" ? "default" : "outline"}
          className="rounded-xl"
          onClick={() => setSplatLoadProfile("full")}
        >
          Full Gaussian
        </Button>
        <Button
          size="sm"
          variant={splatLoadProfile === "balanced" ? "default" : "outline"}
          className="rounded-xl"
          onClick={() => setSplatLoadProfile("balanced")}
        >
          Balanced
        </Button>
        <Button
          size="sm"
          variant={splatLoadProfile === "preview" ? "default" : "outline"}
          className="rounded-xl"
          onClick={() => setSplatLoadProfile("preview")}
        >
          Preview
        </Button>
        {isPersistableArtifact ? (
          <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void persistTransforms()}>
            Save Transforms
          </Button>
        ) : null}
        <div className="rounded-full border border-border/70 bg-background/40 px-2 py-1 text-[11px] text-zinc-300">
          Runtime: {activeRuntimeLabel} ({configuredRuntimeLabel})
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
        <div className="absolute left-3 top-16 z-30 w-[360px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
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
                      window.location.assign(option.href);
                    }}
                  >
                    <span className="shrink-0 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px]">
                      {option.kind}
                    </span>
                    <span className="truncate text-[11px]">{option.label}</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {openPanel === "settings" ? (
        <div className="absolute left-3 bottom-3 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-zinc-300">Settings</p>
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
          <div className="max-h-[280px] space-y-1 overflow-auto pr-1">
            {objectItems.length === 0 ? (
              <div className="rounded-md border border-border/50 px-2 py-1 text-xs text-zinc-400">No scene objects</div>
            ) : (
              objectItems.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={selectedName === item.id ? "default" : "outline"}
                  className="h-8 w-full justify-between gap-2 rounded-md"
                  onClick={() => {
                    if (item.kind === "mesh") {
                      const target = meshRootsRef.current.find((entry) => (entry.name || entry.uuid) === item.id) ?? null;
                      setSelectedObject(target, "mesh");
                    } else {
                      const handle = [...splatHandlesRef.current].find((entry) => entry.id === item.id) ?? null;
                      setSelectedObject(handle?.object ?? null, "splat");
                    }
                    setOpenPanel("transform");
                  }}
                >
                  <span className="truncate text-left text-xs">{item.label}</span>
                  <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px]">
                    {item.kind === "mesh" ? "mesh" : "splat"}
                  </span>
                </Button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {openPanel === "transform" ? (
        <div className="absolute right-3 top-16 z-30 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-md">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-300">Transform</div>
          {selectedKind && transformDraft ? (
            <div className="space-y-2">
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
                  disabled={!selectedRef.current}
                >
                  Reset Transform
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-md text-xs col-span-2"
                  onClick={fitSelection}
                  disabled={!selectedRef.current}
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

      <div ref={containerRef} className="h-full w-full" />

      <div className="pointer-events-none absolute bottom-3 right-3 z-20 rounded-lg border border-white/10 bg-black/55 px-2 py-1 text-[11px] text-zinc-300">
        <Camera className="mr-1 inline h-3.5 w-3.5" />
        Unified viewer
      </div>
    </div>
  );
}
