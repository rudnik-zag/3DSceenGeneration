export type ViewerRenderer = "three" | "babylon-gs" | null;

const GS_KINDS = new Set(["splat", "ksplat", "spz", "gsplat", "splat_ksplat"]);
const MESH_KINDS = new Set(["mesh_glb"]);
const POINT_KINDS = new Set(["point_ply"]);
const GS_EXTENSIONS = [".splat", ".spz", ".compressed.ply"];
const MESH_EXTENSIONS = [".glb", ".gltf"];
const POINT_EXTENSIONS = [".ply"];

function normalizedPath(value: string | null | undefined) {
  if (!value) return "";
  const raw = value.trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname.toLowerCase());
  } catch {
    return decodeURIComponent(raw.toLowerCase().split("?")[0].split("#")[0]);
  }
}

export function extractArtifactExtension(value: string | null | undefined): string | null {
  const path = normalizedPath(value);
  if (!path) return null;

  if (path.endsWith(".compressed.ply")) return ".compressed.ply";
  if (path.endsWith(".splat")) return ".splat";
  if (path.endsWith(".spz")) return ".spz";
  if (path.endsWith(".glb")) return ".glb";
  if (path.endsWith(".gltf")) return ".gltf";
  if (path.endsWith(".ply")) return ".ply";
  if (path.endsWith(".ksplat")) return ".ksplat";

  return null;
}

export interface ViewerArtifactLike {
  kind?: string | null;
  url?: string | null;
  filename?: string | null;
  storageKey?: string | null;
  meta?: Record<string, unknown> | null;
}

function getArtifactExtension(artifact: ViewerArtifactLike) {
  const metaFilename =
    artifact.meta && typeof artifact.meta.filename === "string" ? artifact.meta.filename : null;
  const metaStorageKey =
    artifact.meta && typeof artifact.meta.storageKey === "string" ? artifact.meta.storageKey : null;

  return (
    extractArtifactExtension(artifact.filename) ??
    extractArtifactExtension(metaFilename) ??
    extractArtifactExtension(artifact.storageKey) ??
    extractArtifactExtension(metaStorageKey) ??
    extractArtifactExtension(artifact.url)
  );
}

export function selectViewerRenderer(artifact: ViewerArtifactLike): ViewerRenderer {
  const kind = (artifact.kind ?? "").toLowerCase();
  const ext = getArtifactExtension(artifact);

  if (GS_KINDS.has(kind)) return "babylon-gs";
  if (MESH_KINDS.has(kind)) return "three";
  if (POINT_KINDS.has(kind)) {
    if (ext === ".compressed.ply") return "babylon-gs";
    return "three";
  }

  if (ext && GS_EXTENSIONS.includes(ext)) return "babylon-gs";
  if (ext === ".ksplat") return "babylon-gs";
  if (ext && MESH_EXTENSIONS.includes(ext)) return "three";
  if (ext && POINT_EXTENSIONS.includes(ext)) return "three";

  return null;
}

export function isRenderableInViewer(artifact: ViewerArtifactLike) {
  return selectViewerRenderer(artifact) !== null;
}

export function inferDisplayFileType(artifact: ViewerArtifactLike) {
  const ext = getArtifactExtension(artifact);
  if (ext) return ext.replace(/^\./, "");
  return (artifact.kind ?? "unknown").toLowerCase();
}
