"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";

import { ViewerCanvas } from "@/components/viewer/viewer-canvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { extractArtifactExtension, selectViewerRenderer } from "@/lib/viewer/renderer-switch";

const BabylonSplatViewer = dynamic(
  () => import("@/components/viewer/BabylonSplatViewer").then((mod) => mod.BabylonSplatViewer),
  {
    ssr: false,
    loading: () => (
      <Card className="rounded-2xl border-border/70 panel-blur">
        <CardHeader>
          <CardTitle className="text-white">Loading Babylon renderer...</CardTitle>
        </CardHeader>
      </Card>
    )
  }
);

interface ViewerArtifact {
  id: string;
  kind: "mesh_glb" | "point_ply" | "splat_ksplat" | string;
  url: string;
  mimeType: string;
  meta: Record<string, unknown> | null;
  byteSize?: number | null;
  filename?: string | null;
  storageKey?: string | null;
}

function inferKindFromFilename(filename: string): ViewerArtifact["kind"] | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".compressed.ply")) return "gsplat";
  if (lower.endsWith(".ply")) return "point_ply";
  if (lower.endsWith(".glb") || lower.endsWith(".gltf")) return "mesh_glb";
  if (lower.endsWith(".ksplat")) return "ksplat";
  if (lower.endsWith(".spz")) return "spz";
  if (lower.endsWith(".splat")) return "splat";
  return null;
}

async function detectKindForLocalFile(file: File): Promise<ViewerArtifact["kind"] | null> {
  const directKind = inferKindFromFilename(file.name);
  if (!directKind) return null;

  if (directKind !== "point_ply") {
    return directKind;
  }

  try {
    const headerText = await file.slice(0, 256 * 1024).text();
    const isGaussianHeader =
      headerText.includes("end_header") &&
      headerText.includes("f_dc_0") &&
      headerText.includes("f_dc_1") &&
      headerText.includes("f_dc_2");

    if (isGaussianHeader) {
      return "gsplat";
    }
  } catch {
    // Keep default point_ply when header detection fails.
  }

  return "point_ply";
}

function isBlobUrl(url: string) {
  return url.startsWith("blob:");
}

export function ViewerLoader({ initialArtifact }: { initialArtifact: ViewerArtifact | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localArtifact, setLocalArtifact] = useState<ViewerArtifact | null>(null);
  const [plyRendererOverride, setPlyRendererOverride] = useState<"three" | "babylon-gs" | null>(null);

  const activeArtifact = useMemo(() => localArtifact ?? initialArtifact, [initialArtifact, localArtifact]);
  const renderer = useMemo(() => (activeArtifact ? selectViewerRenderer(activeArtifact) : null), [activeArtifact]);
  const artifactExt = useMemo(
    () => (activeArtifact ? extractArtifactExtension(activeArtifact.filename ?? activeArtifact.url) : null),
    [activeArtifact]
  );
  const effectiveRenderer = useMemo(() => {
    if (artifactExt === ".ply" && plyRendererOverride) {
      return plyRendererOverride;
    }
    return renderer;
  }, [artifactExt, plyRendererOverride, renderer]);
  const threeCompatibleArtifact = useMemo(() => {
    if (!activeArtifact) return null;
    if (effectiveRenderer !== "three") return activeArtifact;
    if (artifactExt !== ".ply") return activeArtifact;
    return {
      ...activeArtifact,
      kind: "point_ply"
    };
  }, [activeArtifact, artifactExt, effectiveRenderer]);

  useEffect(() => {
    return () => {
      if (localArtifact?.url && isBlobUrl(localArtifact.url)) {
        URL.revokeObjectURL(localArtifact.url);
      }
    };
  }, [localArtifact]);

  useEffect(() => {
    setPlyRendererOverride(null);
  }, [activeArtifact?.id]);

  const onPickLocalFile = () => {
    inputRef.current?.click();
  };

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
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
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 panel-blur p-3">
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
        {renderer ? (
          <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/65">
            Renderer: {effectiveRenderer === "babylon-gs" ? "Babylon GS" : "Three.js"}
          </Badge>
        ) : null}
        {artifactExt === ".ply" && activeArtifact ? (
          <Button
            size="sm"
            variant={effectiveRenderer === "babylon-gs" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() =>
              setPlyRendererOverride((current) => {
                const baseline = current ?? renderer ?? "three";
                return baseline === "three" ? "babylon-gs" : "three";
              })
            }
          >
            {effectiveRenderer === "babylon-gs" ? "Use Three PLY" : "Render PLY as GS"}
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
        {activeArtifact && effectiveRenderer === "babylon-gs" ? (
          <BabylonSplatViewer artifact={activeArtifact} />
        ) : activeArtifact && effectiveRenderer === "three" ? (
          <ViewerCanvas artifact={threeCompatibleArtifact ?? activeArtifact} />
        ) : activeArtifact ? (
          <Card className="rounded-2xl border-border/70 panel-blur">
            <CardHeader>
              <CardTitle className="text-white">Unsupported artifact type</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Could not infer renderer for this artifact. Try .glb/.gltf/.ply for Three.js or .splat/.spz/.compressed.ply for Babylon GS.
            </CardContent>
          </Card>
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
