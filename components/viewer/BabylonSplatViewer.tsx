"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FlipVertical2, RefreshCw, SlidersHorizontal } from "lucide-react";
import {
  ArcRotateCamera,
  Color4,
  Engine,
  GaussianSplattingMesh,
  HemisphericLight,
  Scene,
  SceneLoader,
  TransformNode,
  Vector3,
  WebGPUEngine
} from "@babylonjs/core";
import type { AbstractMesh } from "@babylonjs/core";
import "@babylonjs/loaders";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { extractArtifactExtension, inferDisplayFileType } from "@/lib/viewer/renderer-switch";

interface ViewerArtifact {
  id: string;
  kind: string;
  url: string;
  mimeType: string;
  meta: Record<string, unknown> | null;
  byteSize?: number | null;
  filename?: string | null;
  storageKey?: string | null;
}

function toMegabytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveByteSize(artifact: ViewerArtifact) {
  if (typeof artifact.byteSize === "number") return artifact.byteSize;
  if (artifact.meta && typeof artifact.meta.byteSize === "number") return artifact.meta.byteSize;
  return null;
}

function findPrimarySplatMesh(meshes: AbstractMesh[]) {
  const gaussian = meshes.find((mesh) => mesh instanceof GaussianSplattingMesh);
  if (gaussian) return gaussian;

  const byClassName = meshes.find((mesh) => mesh.getClassName().toLowerCase().includes("gaussian"));
  if (byClassName) return byClassName;

  const withVertices = meshes.find((mesh) => mesh.getTotalVertices() > 0);
  return withVertices ?? meshes[0] ?? null;
}

function getSplatCount(mesh: AbstractMesh | null) {
  if (!mesh) return null;

  const fromKnownFields =
    (mesh as { splatCount?: number }).splatCount ??
    (mesh as { _splatCount?: number })._splatCount ??
    (mesh as { _vertexCount?: number })._vertexCount ??
    (mesh as { vertexCount?: number }).vertexCount;

  if (typeof fromKnownFields === "number" && Number.isFinite(fromKnownFields)) {
    return fromKnownFields;
  }

  const vertices = mesh.getTotalVertices();
  if (Number.isFinite(vertices) && vertices > 0) {
    return vertices;
  }

  return null;
}

function fitCamera(camera: ArcRotateCamera, mesh: AbstractMesh | null) {
  if (!mesh) return;
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  const center = min.add(max).scale(0.5);
  const radius = Vector3.Distance(min, max) * 0.5 || 1;

  camera.target = center;
  camera.radius = Math.max(radius * 2.4, 0.8);
  camera.beta = Math.PI / 3;
  camera.alpha = Math.PI / 2;
}

export function BabylonSplatViewer({ artifact }: { artifact: ViewerArtifact }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const engineRef = useRef<Engine | WebGPUEngine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const cameraRef = useRef<ArcRotateCamera | null>(null);
  const splatMeshRef = useRef<AbstractMesh | null>(null);
  const splatRootRef = useRef<TransformNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposedRef = useRef(false);

  const [loadingProgress, setLoadingProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [engineType, setEngineType] = useState<"WebGPU" | "WebGL">("WebGL");
  const [loadTimeMs, setLoadTimeMs] = useState<number | null>(null);
  const [splatCount, setSplatCount] = useState<number | null>(null);
  const [meshName, setMeshName] = useState<string>("GaussianSplattingMesh");
  const [invertY, setInvertY] = useState(false);
  const [qualityPreset, setQualityPreset] = useState("native");

  const byteSize = useMemo(() => resolveByteSize(artifact), [artifact]);
  const fileType = useMemo(() => inferDisplayFileType(artifact), [artifact]);
  const extension = useMemo(
    () =>
      extractArtifactExtension(artifact.filename) ??
      extractArtifactExtension(artifact.storageKey) ??
      extractArtifactExtension(artifact.url),
    [artifact.filename, artifact.storageKey, artifact.url]
  );

  useEffect(() => {
    const target = splatRootRef.current ?? splatMeshRef.current;
    if (!target) return;

    target.rotation.x = invertY ? Math.PI : 0;
    target.computeWorldMatrix(true);
  }, [invertY]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    disposedRef.current = false;
    setStatus("loading");
    setError(null);
    setLoadingProgress(0);
    setLoadTimeMs(null);
    setSplatCount(null);

    let visibilityHandler: (() => void) | null = null;
    let resizeHandler: (() => void) | null = null;
    let activeEngine: Engine | WebGPUEngine | null = null;
    let activeScene: Scene | null = null;

    const updateCameraClipping = () => {
      const camera = cameraRef.current;
      if (!camera) return;

      const near = Math.max(camera.radius / 4000, 0.00005);
      const far = Math.max(5000, camera.radius * 12000);

      camera.minZ = near;
      camera.maxZ = far;
    };

    const stopRenderLoop = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const startRenderLoop = () => {
      if (rafRef.current !== null || !activeScene || disposedRef.current || document.hidden) return;

      const renderFrame = () => {
        if (disposedRef.current || document.hidden || !activeScene) {
          rafRef.current = null;
          return;
        }

        updateCameraClipping();
        activeScene.render();
        rafRef.current = requestAnimationFrame(renderFrame);
      };

      rafRef.current = requestAnimationFrame(renderFrame);
    };

    const createEngine = async () => {
      try {
        const supported = await WebGPUEngine.IsSupportedAsync;
        if (supported) {
          const webgpu = new WebGPUEngine(canvas, {
            antialias: true,
            adaptToDeviceRatio: true
          });
          await webgpu.initAsync();
          setEngineType("WebGPU");
          return webgpu;
        }
      } catch {
        // Fall through to WebGL engine.
      }

      setEngineType("WebGL");
      return new Engine(canvas, true, {
        antialias: true,
        adaptToDeviceRatio: true
      });
    };

    const initialize = async () => {
      try {
        activeEngine = await createEngine();
        if (disposedRef.current) return;

        engineRef.current = activeEngine;
        activeScene = new Scene(activeEngine);
        activeScene.clearColor = new Color4(0.03, 0.04, 0.07, 1);
        sceneRef.current = activeScene;

        const camera = new ArcRotateCamera("splat-camera", Math.PI / 2, Math.PI / 3, 3, Vector3.Zero(), activeScene);
        camera.lowerRadiusLimit = 0.01;
        camera.upperRadiusLimit = 10_000;
        camera.lowerBetaLimit = null;
        camera.upperBetaLimit = null;
        camera.allowUpsideDown = true;
        camera.wheelPrecision = 80;
        camera.wheelDeltaPercentage = 0.01;
        camera.minZ = 0.00005;
        camera.maxZ = 100000;
        camera.attachControl(canvas, true);
        cameraRef.current = camera;

        new HemisphericLight("splat-hemi", new Vector3(0, 1, 0), activeScene);

        const preImportMeshIds = new Set(activeScene.meshes.map((mesh) => mesh.uniqueId));
        const loadStart = performance.now();
        const result = await SceneLoader.ImportMeshAsync(null, "", artifact.url, activeScene, (event) => {
          if (disposedRef.current) return;
          if (event.lengthComputable && event.total > 0) {
            setLoadingProgress(Math.round((event.loaded / event.total) * 100));
          }
        }, extension ?? undefined);

        if (disposedRef.current) return;

        const importedMeshes = activeScene.meshes.filter((mesh) => !preImportMeshIds.has(mesh.uniqueId));
        const sourceMeshes = importedMeshes.length > 0 ? importedMeshes : result.meshes;

        const root = new TransformNode("gs-root", activeScene);
        sourceMeshes.forEach((mesh) => {
          mesh.parent = root;
        });
        splatRootRef.current = root;

        const primary = findPrimarySplatMesh(sourceMeshes);
        splatMeshRef.current = primary;
        setMeshName(primary?.name || "GaussianSplattingMesh");
        setSplatCount(getSplatCount(primary));
        root.rotation.x = invertY ? Math.PI : 0;
        root.computeWorldMatrix(true);
        fitCamera(camera, primary);
        updateCameraClipping();

        setLoadTimeMs(performance.now() - loadStart);
        setLoadingProgress(100);
        setStatus("ready");

        visibilityHandler = () => {
          if (document.hidden) stopRenderLoop();
          else startRenderLoop();
        };
        document.addEventListener("visibilitychange", visibilityHandler);

        resizeHandler = () => activeEngine?.resize();
        window.addEventListener("resize", resizeHandler);

        resizeObserverRef.current = new ResizeObserver(() => {
          activeEngine?.resize();
        });
        resizeObserverRef.current.observe(container);

        startRenderLoop();
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to load Gaussian splat scene.");
      }
    };

    initialize();

    return () => {
      disposedRef.current = true;
      stopRenderLoop();

      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      if (resizeHandler) window.removeEventListener("resize", resizeHandler);

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      splatMeshRef.current = null;
      splatRootRef.current = null;
      sceneRef.current?.dispose();
      sceneRef.current = null;

      engineRef.current?.dispose();
      engineRef.current = null;
      cameraRef.current = null;
    };
  }, [artifact.id, artifact.url, extension]);

  const resetCamera = () => {
    const camera = cameraRef.current;
    const mesh = splatMeshRef.current;
    if (!camera || !mesh) return;
    fitCamera(camera, mesh);
    camera.minZ = Math.max(camera.radius / 4000, 0.00005);
    camera.maxZ = Math.max(5000, camera.radius * 12000);
  };

  const resetYScale = () => {
    const target = splatRootRef.current ?? splatMeshRef.current;
    if (!target) return;
    setInvertY(false);
    target.rotation.x = 0;
    target.computeWorldMatrix(true);
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-none bg-[#05070f] md:rounded-2xl md:border md:border-border/70">
      <div className="absolute left-3 top-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-black/45 p-2 backdrop-blur-sm">
        <Button size="sm" variant="outline" className="rounded-xl" onClick={resetCamera}>
          <RefreshCw className="mr-1 h-4 w-4" /> Reset camera
        </Button>
        <Button
          size="sm"
          variant={invertY ? "default" : "outline"}
          className="rounded-xl"
          onClick={() => setInvertY((value) => !value)}
        >
          <FlipVertical2 className="mr-1 h-4 w-4" /> Invert Y
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={resetYScale}>
          Reset Y
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="rounded-xl">
              <SlidersHorizontal className="mr-1 h-4 w-4" /> Inspector
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[360px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-zinc-400">Renderer</span>
              <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/60">
                Babylon.js ({engineType})
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/70 bg-background/45 p-2 text-xs">
              <span className="text-muted-foreground">File type</span>
              <span>{fileType}</span>
              <span className="text-muted-foreground">Byte size</span>
              <span>{byteSize !== null ? toMegabytes(byteSize) : "unknown"}</span>
              <span className="text-muted-foreground">Load time</span>
              <span>{loadTimeMs !== null ? `${loadTimeMs.toFixed(0)} ms` : "—"}</span>
              <span className="text-muted-foreground">Splat count</span>
              <span>{splatCount !== null ? splatCount.toLocaleString() : "unknown"}</span>
            </div>

            <div className="mt-2 rounded-xl border border-border/70 bg-background/45 p-2">
              <p className="mb-1 text-xs text-muted-foreground">Quality / downsample</p>
              <Select value={qualityPreset} onValueChange={setQualityPreset}>
                <SelectTrigger className="h-8 rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native</SelectItem>
                  <SelectItem value="balanced">Balanced (placeholder)</SelectItem>
                  <SelectItem value="performance">Performance (placeholder)</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Placeholder UI for future Babylon downsample/quality parameters.
              </p>
            </div>

            <ScrollArea className="mt-2 h-[36vh] rounded-xl border border-border/70 bg-background/35 p-2">
              <div className="space-y-1 text-xs">
                <p className="text-muted-foreground">Artifact kind</p>
                <p className="font-medium text-zinc-100">{artifact.kind}</p>
                <p className="mt-2 text-muted-foreground">Source</p>
                <p className="font-medium text-zinc-100">{artifact.filename ?? meshName}</p>
                <p className="mt-2 text-muted-foreground">MIME</p>
                <p className="font-medium text-zinc-100">{artifact.mimeType || "unknown"}</p>
                <p className="mt-2 text-muted-foreground">URL</p>
                <p className="break-all text-zinc-300">{artifact.url}</p>
              </div>
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="absolute left-3 top-20 z-20 space-y-2">
        {error ? <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div> : null}
        {status === "loading" ? (
          <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-sm text-zinc-300">
            Loading splat scene... {loadingProgress}%
          </div>
        ) : null}
      </div>

      <div ref={containerRef} className="h-full w-full">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>

      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-lg border border-white/10 bg-black/55 px-2 py-1 text-[11px] text-zinc-300">
        {status} • {splatCount !== null ? `${splatCount.toLocaleString()} splats` : "splat count unknown"}
      </div>
    </div>
  );
}
