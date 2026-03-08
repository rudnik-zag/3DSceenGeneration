"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";

import { UnifiedWorldViewer } from "@/components/viewer/unified-world-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/hooks/use-toast";

interface ViewerArtifact {
  id: string;
  kind: "mesh_glb" | "point_ply" | "splat_ksplat" | string;
  url: string;
  mimeType: string;
  meta: Record<string, unknown> | null;
  byteSize?: number | null;
  filename?: string | null;
  storageKey?: string | null;
  additionalSceneUrls?: string[] | null;
}

type SplatFormatHint = "ply" | "splat" | "ksplat" | "spz" | null;

interface WorldManifestResponse {
  artifactId: string;
  meshes: Array<{ id: string; url: string }>;
  splats: Array<{
    id: string;
    artifactId: string;
    kind?: string;
    tilesetUrl: string | null;
    sourceUrl: string | null;
  }>;
  build?: {
    canBuildTileset?: boolean;
    defaultPresetName?: string;
  };
}

interface UnifiedManifest {
  artifactId?: string;
  camera?: {
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
  };
  meshes: Array<{ id: string; url: string }>;
  splats: Array<{ id: string; tilesetUrl: string | null; sourceUrl: string | null; formatHint?: SplatFormatHint }>;
}

interface ViewerArtifactPickerOption {
  id: string;
  kind: string;
  href: string;
  label: string;
  selected: boolean;
}

interface ViewerArtifactPicker {
  selectedKind: string;
  selectedArtifactText: string;
  activeNodeScope: string | null;
  rendererLabel: string | null;
  options: ViewerArtifactPickerOption[];
}

function normalizeAssetUrlForDedup(url: string): string {
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

function meshIdFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    const keyParam = parsed.searchParams.get("key");
    const source = keyParam && keyParam.length > 0 ? keyParam : parsed.pathname;
    const filename = source.split("/").pop() || fallback;
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    return safe.length > 0 ? safe : fallback;
  } catch {
    const filename = url.split("/").pop() || fallback;
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    return safe.length > 0 ? safe : fallback;
  }
}

function inferKindFromFilename(filename: string): ViewerArtifact["kind"] | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".compressed.ply")) return "splat_ksplat";
  if (lower.endsWith(".ply")) return "point_ply";
  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) return "mesh_glb";
  if (lower.endsWith(".ksplat")) return "splat_ksplat";
  if (lower.endsWith(".spz")) return "splat_ksplat";
  if (lower.endsWith(".splat")) return "splat_ksplat";
  return null;
}

function inferSplatFormatHintFromUrl(url: string): SplatFormatHint {
  const lower = url.toLowerCase();
  if (lower.endsWith(".compressed.ply")) return "ply";
  if (lower.endsWith(".ply")) return "ply";
  if (lower.endsWith(".ksplat")) return "ksplat";
  if (lower.endsWith(".spz")) return "spz";
  if (lower.endsWith(".splat")) return "splat";
  return null;
}

function inferSplatFormatHintFromKind(kind: string | null | undefined): SplatFormatHint {
  const normalized = (kind ?? "").toLowerCase();
  if (normalized === "point_ply") return "ply";
  if (normalized === "splat_ksplat") return "ksplat";
  if (normalized === "splat" || normalized === "gsplat") return "splat";
  if (normalized === "spz") return "spz";
  return null;
}

async function detectKindForLocalFile(file: File): Promise<ViewerArtifact["kind"] | null> {
  const directKind = inferKindFromFilename(file.name);
  if (!directKind) return null;
  return directKind;
}

function isBlobUrl(url: string) {
  return url.startsWith("blob:");
}

function buildSingleArtifactManifest(artifact: ViewerArtifact): UnifiedManifest {
  const extraMeshUrls = Array.isArray(artifact.additionalSceneUrls)
    ? artifact.additionalSceneUrls.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const meshLike = artifact.kind === "mesh_glb" || artifact.url.toLowerCase().endsWith(".glb") || artifact.url.toLowerCase().endsWith(".gltf");
  if (meshLike) {
    const preferPerObjectMeshes = extraMeshUrls.length > 0;
    const meshes: Array<{ id: string; url: string }> = [];
    const knownUrls = new Set<string>();
    if (!preferPerObjectMeshes) {
      meshes.push({ id: `mesh-${artifact.id}`, url: artifact.url });
      knownUrls.add(normalizeAssetUrlForDedup(artifact.url));
    }
    extraMeshUrls.forEach((url, index) => {
      const dedupKey = normalizeAssetUrlForDedup(url);
      if (knownUrls.has(dedupKey)) return;
      knownUrls.add(dedupKey);
      meshes.push({ id: `mesh-extra-${meshIdFromUrl(url, `${artifact.id}-${index}`)}-${index}`, url });
    });
    return {
      artifactId: artifact.id,
      camera: { position: [4, 3, 4], target: [0, 0, 0], fov: 50 },
      meshes,
      splats: []
    };
  }

  const splatLike = artifact.kind === "point_ply" || artifact.kind === "splat_ksplat";
  if (splatLike) {
    const formatHint =
      inferSplatFormatHintFromKind(artifact.kind) ??
      inferSplatFormatHintFromUrl(artifact.url) ??
      inferSplatFormatHintFromUrl(artifact.filename ?? "");
    return {
      artifactId: artifact.id,
      camera: { position: [4, 3, 4], target: [0, 0, 0], fov: 50 },
      meshes: [],
      splats: [{ id: `splat-${artifact.id}`, tilesetUrl: null, sourceUrl: artifact.url, formatHint }]
    };
  }

  return {
    artifactId: artifact.id,
    camera: { position: [4, 3, 4], target: [0, 0, 0], fov: 50 },
    meshes: [],
    splats: []
  };
}

export function ViewerLoader({
  initialArtifact,
  artifactPicker
}: {
  initialArtifact: ViewerArtifact | null;
  artifactPicker?: ViewerArtifactPicker | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localArtifact, setLocalArtifact] = useState<ViewerArtifact | null>(null);
  const [worldManifest, setWorldManifest] = useState<WorldManifestResponse | null>(null);
  const [worldManifestLoading, setWorldManifestLoading] = useState(false);
  const [worldManifestError, setWorldManifestError] = useState<string | null>(null);
  const [buildTilesetLoading, setBuildTilesetLoading] = useState(false);
  const [buildJobId, setBuildJobId] = useState<string | null>(null);

  const activeArtifact = useMemo(() => localArtifact ?? initialArtifact, [initialArtifact, localArtifact]);

  const unifiedManifest = useMemo<UnifiedManifest | null>(() => {
    if (localArtifact) {
      return buildSingleArtifactManifest(localArtifact);
    }
    if (worldManifest) {
      const extraMeshUrls =
        activeArtifact && Array.isArray(activeArtifact.additionalSceneUrls)
          ? activeArtifact.additionalSceneUrls.filter(
              (value): value is string => typeof value === "string" && value.length > 0
            )
          : [];
      const preferPerObjectMeshes = extraMeshUrls.length > 0;
      const baseMeshes = preferPerObjectMeshes
        ? []
        : worldManifest.meshes.map((entry) => ({ id: entry.id, url: entry.url }));
      const mergedMeshes = [...baseMeshes];
      const knownUrls = new Set(mergedMeshes.map((entry) => normalizeAssetUrlForDedup(entry.url)));
      extraMeshUrls.forEach((url, index) => {
        const dedupKey = normalizeAssetUrlForDedup(url);
        if (knownUrls.has(dedupKey)) return;
        knownUrls.add(dedupKey);
        mergedMeshes.push({
          id: `mesh-extra-${meshIdFromUrl(url, `${worldManifest.artifactId}-${index}`)}-${index}`,
          url
        });
      });
      return {
        artifactId: worldManifest.artifactId,
        camera: { position: [4, 3, 4], target: [0, 0, 0], fov: 50 },
        meshes: mergedMeshes,
        splats: worldManifest.splats.map((entry) => ({
          id: entry.id,
          tilesetUrl: entry.tilesetUrl,
          sourceUrl: entry.sourceUrl,
          formatHint:
            inferSplatFormatHintFromKind(entry.kind) ??
            (entry.sourceUrl ? inferSplatFormatHintFromUrl(entry.sourceUrl) : null)
        }))
      };
    }
    if (activeArtifact) {
      return buildSingleArtifactManifest(activeArtifact);
    }
    return null;
  }, [activeArtifact, localArtifact, worldManifest]);

  useEffect(() => {
    return () => {
      if (localArtifact?.url && isBlobUrl(localArtifact.url)) {
        URL.revokeObjectURL(localArtifact.url);
      }
    };
  }, [localArtifact]);

  useEffect(() => {
    if (!activeArtifact || localArtifact) {
      setWorldManifest(null);
      setWorldManifestError(null);
      setWorldManifestLoading(false);
      return;
    }

    let cancelled = false;
    const loadWorldManifest = async () => {
      setWorldManifestLoading(true);
      setWorldManifestError(null);
      try {
        const response = await fetch(`/api/world/manifest?artifactId=${encodeURIComponent(activeArtifact.id)}`, {
          cache: "no-store"
        });
        if (!response.ok) {
          throw new Error(`Failed to load world manifest (${response.status})`);
        }
        const payload = (await response.json()) as WorldManifestResponse;
        if (cancelled) return;
        setWorldManifest(payload);
      } catch (error) {
        if (cancelled) return;
        setWorldManifestError(error instanceof Error ? error.message : "Failed to load world manifest");
        setWorldManifest(null);
      } finally {
        if (!cancelled) setWorldManifestLoading(false);
      }
    };

    void loadWorldManifest();
    return () => {
      cancelled = true;
    };
  }, [activeArtifact, localArtifact]);

  useEffect(() => {
    if (!buildJobId) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/splats/buildTileset?jobId=${encodeURIComponent(buildJobId)}`, {
          cache: "no-store"
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          state?: string;
          failedReason?: string | null;
        };
        if (cancelled) return;
        if (payload.state === "completed") {
          window.clearInterval(timer);
          setBuildJobId(null);
          setBuildTilesetLoading(false);
          toast({
            title: "Tileset Ready",
            description: "Splat tileset build completed."
          });
          if (activeArtifact && !localArtifact) {
            const refresh = await fetch(`/api/world/manifest?artifactId=${encodeURIComponent(activeArtifact.id)}`, {
              cache: "no-store"
            });
            if (refresh.ok) {
              const nextManifest = (await refresh.json()) as WorldManifestResponse;
              if (!cancelled) setWorldManifest(nextManifest);
            }
          }
        }
        if (payload.state === "failed") {
          window.clearInterval(timer);
          setBuildJobId(null);
          setBuildTilesetLoading(false);
          toast({
            title: "Tileset Build Failed",
            description: payload.failedReason ?? "Background build failed."
          });
        }
      } catch {
        // keep polling
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeArtifact, buildJobId, localArtifact]);

  const onBuildTileset = async () => {
    if (!activeArtifact || localArtifact) return;
    try {
      setBuildTilesetLoading(true);
      const response = await fetch("/api/splats/buildTileset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: activeArtifact.id,
          presetName: worldManifest?.build?.defaultPresetName ?? "Default"
        })
      });
      const payload = (await response.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!response.ok || !payload.jobId) {
        throw new Error(payload.error ?? `Build request failed (${response.status})`);
      }
      setBuildJobId(payload.jobId);
      toast({
        title: "Tileset Build Queued",
        description: "Streaming tileset generation started."
      });
    } catch (error) {
      setBuildTilesetLoading(false);
      toast({
        title: "Tileset Build Error",
        description: error instanceof Error ? error.message : "Failed to start tileset build."
      });
    }
  };

  const canBuildTileset = Boolean(!localArtifact && worldManifest?.build?.canBuildTileset);

  const onPickLocalFile = () => {
    inputRef.current?.click();
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const kind = await detectKindForLocalFile(file);
    if (!kind) {
      toast({
        title: "Unsupported file",
        description: "Use .ply, .compressed.ply, .glb/.gltf, .splat, .spz, .ksplat."
      });
      return;
    }

    const url = URL.createObjectURL(file);
    setLocalArtifact((prev) => {
      if (prev?.url && isBlobUrl(prev.url)) {
        URL.revokeObjectURL(prev.url);
      }
      return {
        id: `local-${Date.now()}`,
        kind,
        url,
        mimeType: file.type || "application/octet-stream",
        filename: file.name,
        byteSize: file.size,
        meta: {
          filename: file.name,
          byteSize: file.size
        }
      };
    });
    event.target.value = "";
  };

  const clearLocalArtifact = () => {
    setLocalArtifact((prev) => {
      if (prev?.url && isBlobUrl(prev.url)) {
        URL.revokeObjectURL(prev.url);
      }
      return null;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 panel-blur px-2 py-1.5">
        {artifactPicker ? (
          <>
            <Badge className="rounded-full border border-border/70 bg-background/65">{artifactPicker.selectedKind}</Badge>
            {artifactPicker.activeNodeScope ? (
              <Badge className="rounded-full border border-border/70 bg-background/65">Node {artifactPicker.activeNodeScope}</Badge>
            ) : null}
            {artifactPicker.rendererLabel ? (
              <Badge className="rounded-full border border-border/70 bg-background/65">{artifactPicker.rendererLabel}</Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">{artifactPicker.selectedArtifactText}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="rounded-xl">
                  Select artifact
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[340px] rounded-xl border-border/70 bg-background/95 p-1">
                <ScrollArea className="h-[38vh]">
                  {artifactPicker.options.map((option) => (
                    <DropdownMenuItem key={option.id} asChild className="rounded-lg">
                      <Link href={option.href}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Badge variant={option.selected ? "default" : "secondary"} className="rounded-full">
                            {option.kind}
                          </Badge>
                          <span className="truncate text-xs text-muted-foreground">{option.label}</span>
                        </span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </ScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}

        <Button size="sm" className="rounded-xl" onClick={onPickLocalFile}>
          <FileUp className="mr-1 h-4 w-4" />
          Open local file
        </Button>
        {localArtifact ? (
          <Button size="sm" variant="outline" className="rounded-xl" onClick={clearLocalArtifact}>
            <X className="mr-1 h-4 w-4" />
            Use run artifact
          </Button>
        ) : null}
        <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/65">
          {localArtifact ? "Source: local file" : activeArtifact ? "Source: run artifact" : "No artifact selected"}
        </Badge>
        <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/65">
          Viewer: Unified
        </Badge>
        {canBuildTileset ? (
          <Button size="sm" className="rounded-xl" onClick={onBuildTileset} disabled={buildTilesetLoading || Boolean(buildJobId)}>
            {buildTilesetLoading || buildJobId ? "Building tileset..." : "Build Tileset"}
          </Button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept=".ply,.compressed.ply,.glb,.gltf,.ksplat,.spz,.splat"
          className="hidden"
          onChange={onFileChange}
        />
      </div>

      <div className="min-h-0 flex-1">
        {worldManifestLoading && !localArtifact ? (
          <Card className="rounded-2xl border-border/70 panel-blur">
            <CardHeader>
              <CardTitle className="text-white">Loading world manifest...</CardTitle>
            </CardHeader>
          </Card>
        ) : worldManifestError && !localArtifact ? (
          <Card className="rounded-2xl border-border/70 panel-blur">
            <CardHeader>
              <CardTitle className="text-white">World manifest unavailable</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{worldManifestError}</CardContent>
          </Card>
        ) : unifiedManifest ? (
          <UnifiedWorldViewer manifest={unifiedManifest} />
        ) : (
          <Card className="rounded-2xl border-border/70 panel-blur">
            <CardHeader>
              <CardTitle className="text-white">No 3D artifact loaded</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Open a local `.ply` / `.glb` file, or generate artifacts from the canvas workflow.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
