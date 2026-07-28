"use client";

import { memo, useEffect, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import { Handle, NodeProps, NodeResizer, Position } from "reactflow";
import {
  Boxes,
  Camera,
  Clock3,
  FileCode2,
  Film,
  Image as ImageIcon,
  Layers,
  Pause,
  Play,
  Sparkles,
  Type as TypeIcon,
  X,
  UploadCloud,
  WandSparkles,
  ExternalLink
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getSceneGenerationPresetNames } from "@/lib/graph/scene-generation-presets";
import { nodeSpecRegistry } from "@/lib/graph/node-specs";
import { cn } from "@/lib/utils";
import { GraphNodeData, WorkflowNodeType } from "@/types/workflow";

const statusClass: Record<string, string> = {
  idle: "border-[#505050] bg-[#2a2a2a] text-[#b6b6b6]",
  running: "border-[#4e6f8f] bg-[#283443] text-[#b7d4ee]",
  success: "border-[#50745a] bg-[#2b3a2f] text-[#b8dcc0]",
  error: "border-[#7f4b4b] bg-[#3a2a2a] text-[#e7bcbc]",
  "cache-hit": "border-[#7d6a47] bg-[#3a3226] text-[#e8d6b1]"
};

const previewTint: Record<string, string> = {
  image: "from-[#424242] to-[#2e2e2e]",
  mask: "from-[#3f3f3f] to-[#2c2c2c]",
  json: "from-[#414141] to-[#2f2f2f]",
  mesh_glb: "from-[#3e3e3e] to-[#2a2a2a]",
  point_ply: "from-[#3e3e3e] to-[#2a2a2a]",
  splat_ksplat: "from-[#3e3e3e] to-[#2a2a2a]"
};

const nodeIconMap: Partial<Record<WorkflowNodeType, ComponentType<{ className?: string }>>> = {
  "input.image": ImageIcon,
  "input.video": Film,
  "input.text": TypeIcon,
  "input.cameraPath": Camera,
  "viewer.environment": Sparkles,
  "model.groundingdino": Boxes,
  "model.sam2": Layers,
  "model.sam3d_objects": Boxes,
  "pipeline.scene_generation": Boxes,
  "model.qwen_vl": Sparkles,
  "model.qwen_image_edit": WandSparkles,
  "model.texturing": WandSparkles,
  "geo.depth_estimation": Sparkles,
  "geo.pointcloud_from_depth": Sparkles,
  "geo.mesh_reconstruction": Boxes,
  "geo.uv_unwrap": Layers,
  "geo.bake_textures": Sparkles,
  "out.export_scene": FileCode2,
  "out.open_in_viewer": Sparkles
};

const modelTagMap: Partial<Record<WorkflowNodeType, string>> = {
  "input.text": "GPT-5.2",
  "input.image": "Reference",
  "input.video": "Reference",
  "viewer.environment": "Lighting",
  "model.groundingdino": "ObjectDetection",
  "model.sam2": "SegmentScene",
  "model.sam3d_objects": "CustomSceneGen",
  "pipeline.scene_generation": "SceneGeneration",
  "model.qwen_vl": "Qwen-VL",
  "model.qwen_image_edit": "Qwen Image Edit",
  "model.texturing": "Texturing",
  "geo.depth_estimation": "Depth",
  "geo.pointcloud_from_depth": "Points",
  "geo.mesh_reconstruction": "Mesher",
  "out.export_scene": "Exporter",
  "out.open_in_viewer": "Preview"
};

function pickPromptText(data: GraphNodeData) {
  const value = data.params?.value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const prompt = data.params?.prompt;
  if (typeof prompt === "string" && prompt.trim().length > 0) return prompt.trim();
  return "";
}

function formatArtifactVersionLabel(artifact: {
  id: string;
  kind: string;
  createdAt?: string;
}) {
  const ts = artifact.createdAt ? new Date(artifact.createdAt) : null;
  const timeLabel = ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleTimeString() : "unknown time";
  return `${artifact.id.slice(0, 8)} · ${artifact.kind} · ${timeLabel}`;
}

type PreviewSequenceManifest = {
  media_type: "image" | "video";
  frame_count: number;
  fps: number;
  frames: Array<{
    index: number;
    depth_storage_key: string;
    source_frame_index: number;
    timestamp_sec: number;
  }>;
};

function buildStorageObjectUrl(storageKey: string) {
  return `/api/storage/object?key=${encodeURIComponent(storageKey)}`;
}

function looksLikeVideoUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value, "http://localhost");
    const key = parsed.searchParams.get("key");
    return parsed.pathname.toLowerCase().endsWith(".mp4") || key?.toLowerCase().endsWith(".mp4") === true;
  } catch {
    return value.toLowerCase().includes(".mp4");
  }
}

function normalizeSequenceManifest(raw: unknown): PreviewSequenceManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const mediaType = candidate.media_type === "video" ? "video" : "image";
  const fps = Number.isFinite(Number(candidate.fps)) ? Math.max(1, Math.floor(Number(candidate.fps))) : 12;
  const framesRaw = Array.isArray(candidate.frames) ? candidate.frames : [];
  const frames = framesRaw
    .map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const frame = entry as Record<string, unknown>;
      const depthStorageKey =
        typeof frame.depth_storage_key === "string" && frame.depth_storage_key.trim().length > 0
          ? frame.depth_storage_key.trim()
          : null;
      if (!depthStorageKey) return null;
      return {
        index: Number.isFinite(Number(frame.index)) ? Math.max(0, Math.floor(Number(frame.index))) : index,
        depth_storage_key: depthStorageKey,
        source_frame_index: Number.isFinite(Number(frame.source_frame_index))
          ? Math.max(0, Math.floor(Number(frame.source_frame_index)))
          : index,
        timestamp_sec: Number.isFinite(Number(frame.timestamp_sec)) ? Math.max(0, Number(frame.timestamp_sec)) : 0
      };
    })
    .filter((value): value is PreviewSequenceManifest["frames"][number] => Boolean(value));

  if (frames.length === 0) return null;

  return {
    media_type: mediaType,
    frame_count: Number.isFinite(Number(candidate.frame_count)) ? Math.max(1, Math.floor(Number(candidate.frame_count))) : frames.length,
    fps,
    frames
  };
}

let sam2ConfigCache: string[] | null = null;
let sam2ConfigInflight: Promise<string[]> | null = null;
let sam3dConfigCache: string[] | null = null;
let sam3dConfigInflight: Promise<string[]> | null = null;

async function fetchSam2Configs() {
  if (sam2ConfigCache) return sam2ConfigCache;
  if (sam2ConfigInflight) return sam2ConfigInflight;
  sam2ConfigInflight = fetch("/api/sam2/configs", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) {
        return ["sam2.1_hiera_l.yaml"];
      }
      const payload = (await res.json()) as { configs?: unknown };
      if (!Array.isArray(payload.configs)) {
        return ["sam2.1_hiera_l.yaml"];
      }
      const normalized = payload.configs
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
      return normalized.length > 0 ? normalized : ["sam2.1_hiera_l.yaml"];
    })
    .catch(() => ["sam2.1_hiera_l.yaml"])
    .finally(() => {
      sam2ConfigInflight = null;
    });

  sam2ConfigCache = await sam2ConfigInflight;
  return sam2ConfigCache;
}

async function fetchSam3dConfigs() {
  if (sam3dConfigCache) return sam3dConfigCache;
  if (sam3dConfigInflight) return sam3dConfigInflight;
  sam3dConfigInflight = fetch("/api/sam3d/configs", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) {
        return ["hf"];
      }
      const payload = (await res.json()) as { configs?: unknown };
      if (!Array.isArray(payload.configs)) {
        return ["hf"];
      }
      const normalized = payload.configs
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
      return normalized.length > 0 ? normalized : ["hf"];
    })
    .catch(() => ["hf"])
    .finally(() => {
      sam3dConfigInflight = null;
    });

  sam3dConfigCache = await sam3dConfigInflight;
  return sam3dConfigCache;
}

function WorkflowNodeImpl({ id, data, type, selected }: NodeProps<GraphNodeData>) {
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [hasCustomImageWidth, setHasCustomImageWidth] = useState(false);
  const nodeType = type as WorkflowNodeType;
  const spec = nodeSpecRegistry[nodeType];
  const Icon = nodeIconMap[nodeType] ?? Sparkles;
  const isGroundingDinoNode = nodeType === "model.groundingdino";
  const isQwenImageEditNode = nodeType === "model.qwen_image_edit";
  const isSam2Node = nodeType === "model.sam2";
  const isCustomSceneGenNode = nodeType === "model.sam3d_objects";
  const isSceneGenerationPipelineNode = nodeType === "pipeline.scene_generation";
  const isSceneGenerationNode = isCustomSceneGenNode || isSceneGenerationPipelineNode;
  const isPreviewNode = nodeType === "out.open_in_viewer";
  const [sam2CfgOptions, setSam2CfgOptions] = useState<string[]>(["sam2.1_hiera_l.yaml"]);
  const [sam3dCfgOptions, setSam3dCfgOptions] = useState<string[]>(["hf"]);
  const isInputImageNode = nodeType === "input.image";
  const isInputVideoNode = nodeType === "input.video";
  const isInputMediaNode = isInputImageNode || isInputVideoNode;
  const inputImageSourceMode =
    isInputImageNode && data.params?.sourceMode === "generate" ? "generate" : "upload";
  const inputImageModel =
    isInputImageNode && typeof data.params?.generatorModel === "string"
      ? data.params.generatorModel === "Qwen-Image-Edit"
        ? "Qwen-Distill"
        : data.params.generatorModel
      : "";
  const inputImagePrompt =
    isInputImageNode && typeof data.params?.prompt === "string"
      ? data.params.prompt
      : "";
  const isImageGenerationNode = isInputImageNode && inputImageSourceMode === "generate";
  const isTextNode = nodeType === "input.text";
  const effectiveArtifactKind = data.latestArtifactKind;
  const effectiveArtifactMimeType = data.latestArtifactMimeType ?? null;
  const effectiveArtifactType = data.latestArtifactType ?? null;
  const isImageNode = isInputMediaNode || isPreviewNode;
  const usesImageSizing = isInputMediaNode || isPreviewNode;
  const hasImagePreview = Boolean(data.previewUrl);
  const canRunNode =
    Boolean(data.onRunNode && spec.ui?.nodeRunEnabled) &&
    (!isInputImageNode || (isImageGenerationNode && inputImageModel.trim().length > 0));
  const promptText = pickPromptText(data);
  const scale = data.uiScale ?? "balanced";
  const defaultImageWidth = scale === "compact" ? 224 : scale === "cinematic" ? 296 : 252;
  const minNodeWidth =
    scale === "compact"
      ? isTextNode
        ? 228
        : usesImageSizing
          ? 224
          : 210
      : scale === "cinematic"
        ? isTextNode
          ? 300
          : usesImageSizing
            ? 296
            : 280
        : isTextNode
          ? 260
          : usesImageSizing
            ? 252
            : 238;
  const minNodeHeight = usesImageSizing ? 180 : isTextNode ? 140 : 120;
  const sizeClass =
    scale === "compact"
      ? isTextNode
        ? "min-w-[228px]"
        : usesImageSizing
          ? hasCustomImageWidth
            ? "w-full min-w-0 max-w-none"
            : "w-[224px] max-w-[224px] min-w-[224px]"
          : "min-w-[210px]"
      : scale === "cinematic"
        ? isTextNode
          ? "min-w-[300px]"
          : usesImageSizing
            ? hasCustomImageWidth
              ? "w-full min-w-0 max-w-none"
              : "w-[296px] max-w-[296px] min-w-[296px]"
            : "min-w-[280px]"
        : isTextNode
          ? "min-w-[260px]"
          : usesImageSizing
            ? hasCustomImageWidth
              ? "w-full min-w-0 max-w-none"
              : "w-[252px] max-w-[252px] min-w-[252px]"
            : "min-w-[238px]";
  const tag = modelTagMap[nodeType];
  const dinoPrompt = isGroundingDinoNode && typeof data.params?.prompt === "string" ? data.params.prompt : "";
  const dinoHasOutput = isGroundingDinoNode && Boolean(data.latestArtifactId);
  const qwenImageEditPrompt =
    isQwenImageEditNode && typeof data.params?.prompt === "string" ? data.params.prompt : "";
  const previewMode =
    isPreviewNode && typeof data.params?.previewMode === "string" && ["auto", "single", "sequence"].includes(data.params.previewMode)
      ? data.params.previewMode
      : "auto";
  const previewFit =
    isPreviewNode && data.params?.previewFit === "cover"
      ? "cover"
      : "contain";
  const sequenceFps =
    isPreviewNode && Number.isFinite(Number(data.params?.sequenceFps))
      ? Math.max(1, Math.min(60, Math.floor(Number(data.params.sequenceFps))))
      : 12;
  const sequenceLoop = isPreviewNode ? data.params?.sequenceLoop !== false : true;
  const sequenceAutoplay = isPreviewNode ? data.params?.sequenceAutoplay === true : true;
  const previewSourceArtifact = isPreviewNode ? data.outputArtifacts?.artifact ?? null : null;
  const effectivePreviewUrl = data.previewUrl ?? previewSourceArtifact?.previewUrl ?? previewSourceArtifact?.url ?? null;
  const previewSourceSemantic =
    previewSourceArtifact?.meta && typeof previewSourceArtifact.meta.semantic === "string"
      ? previewSourceArtifact.meta.semantic
      : null;
  const isVideoPreview =
    isInputVideoNode ||
    effectiveArtifactMimeType === "video/mp4" ||
    effectiveArtifactType === "Video" ||
    previewSourceArtifact?.mimeType === "video/mp4" ||
    previewSourceArtifact?.artifactType === "Video" ||
    previewSourceSemantic === "depth_video" ||
    looksLikeVideoUrl(effectivePreviewUrl);
  const shouldPreferVideoPreview = Boolean(isPreviewNode && effectivePreviewUrl && isVideoPreview);
  const previewSourceMeta = previewSourceArtifact?.meta ?? null;
  const hasSequenceManifestArtifact =
    isPreviewNode &&
    previewSourceArtifact?.kind === "json" &&
    previewSourceMeta &&
    ((typeof previewSourceMeta.outputKey === "string" && previewSourceMeta.outputKey === "sequence") ||
      (typeof previewSourceMeta.semantic === "string" && previewSourceMeta.semantic === "image_sequence")) &&
    typeof previewSourceArtifact.url === "string" &&
    previewSourceArtifact.url.length > 0;
  const [sequenceManifest, setSequenceManifest] = useState<PreviewSequenceManifest | null>(null);
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [sequenceError, setSequenceError] = useState<string | null>(null);
  const [sequenceFrameIndex, setSequenceFrameIndex] = useState(0);
  const [sequencePlaying, setSequencePlaying] = useState(false);
  const [sequenceFrameUrls, setSequenceFrameUrls] = useState<Record<string, string>>({});
  const sequenceFrameUrlRegistryRef = useRef<Record<string, string>>({});
  const shouldLoadSequenceManifest = Boolean(
    hasSequenceManifestArtifact &&
    !shouldPreferVideoPreview &&
    ["auto", "single", "sequence"].includes(previewMode)
  );
  const shouldRenderSequence = Boolean(
    shouldLoadSequenceManifest &&
    sequenceManifest
  );
  const sequenceFrames = sequenceManifest?.frames ?? [];
  const clampedSequenceFrameIndex =
    sequenceFrames.length > 0 ? Math.min(sequenceFrameIndex, sequenceFrames.length - 1) : 0;
  const activeSequenceFrame = sequenceFrames[clampedSequenceFrameIndex] ?? null;
  const activeSequenceFrameUrl = activeSequenceFrame
    ? sequenceFrameUrls[activeSequenceFrame.depth_storage_key] ?? null
    : null;
  const shouldAutoPlaySequence = Boolean(shouldRenderSequence && previewMode !== "single" && sequenceAutoplay);
  const hasOpenablePreview = (Boolean(effectivePreviewUrl) || Boolean(activeSequenceFrameUrl)) && (isPreviewNode || isInputMediaNode);
  const hasSam2BoxesConfig = isSam2Node ? Boolean(data.hasBoxesConfigConnection) : false;
  const sam2ModeParam =
    isSam2Node && typeof data.params?.mode === "string" ? data.params.mode : "auto";
  const sam2ComputedMode =
    sam2ModeParam === "full" ? "full" : sam2ModeParam === "guided" ? "guided" : hasSam2BoxesConfig ? "guided" : "full";
  const sam2DisplayedMode =
    sam2ModeParam === "full" ? "full" : hasSam2BoxesConfig ? "guided" : "full";
  const sam2Cfg =
    isSam2Node && typeof data.params?.sam2Cfg === "string" && data.params.sam2Cfg.trim().length > 0
      ? data.params.sam2Cfg.trim()
      : "sam2.1_hiera_l.yaml";
  const sceneConfig =
    isCustomSceneGenNode && typeof data.params?.config === "string" && data.params.config.trim().length > 0
      ? data.params.config.trim()
      : "hf";
  const scenePreset =
    isCustomSceneGenNode &&
    typeof data.params?.configPreset === "string" &&
    getSceneGenerationPresetNames().includes(data.params.configPreset as "Default" | "HighQuality" | "FastPreview" | "Custom")
      ? (data.params.configPreset as "Default" | "HighQuality" | "FastPreview" | "Custom")
      : isSceneGenerationPipelineNode &&
          typeof data.params?.SceneDetailedOption === "string" &&
          getSceneGenerationPresetNames().includes(
            data.params.SceneDetailedOption as "Default" | "HighQuality" | "FastPreview" | "Custom"
          )
        ? (data.params.SceneDetailedOption as "Default" | "HighQuality" | "FastPreview" | "Custom")
      : "Default";
  const sceneFormat =
    isCustomSceneGenNode &&
    typeof data.params?.format === "string" &&
    (data.params.format === "mesh_glb" || data.params.format === "point_ply")
      ? data.params.format
      : isSceneGenerationPipelineNode &&
          typeof data.params?.SceneOutputFormat === "string" &&
          (data.params.SceneOutputFormat === "mesh_glb" || data.params.SceneOutputFormat === "point_ply")
        ? data.params.SceneOutputFormat
      : "mesh_glb";
  const sceneRunAllMasksInOneProcess = isCustomSceneGenNode
    ? data.params?.runAllMasksInOneProcess !== false
    : isSceneGenerationPipelineNode
      ? typeof data.params?.SceneMaskExecution === "string"
        ? data.params.SceneMaskExecution !== "per_mask"
        : data.params?.runAllMasksInOneProcess !== false
      : true;
  const sceneObjectPrompt =
    isSceneGenerationPipelineNode && typeof data.params?.objectPrompt === "string"
      ? data.params.objectPrompt
      : "";
  const sceneViewerArtifactId = isSceneGenerationPipelineNode
    ? data.outputArtifacts?.generatedScene?.id ?? data.outputArtifacts?.scene?.id ?? data.latestArtifactId
    : isCustomSceneGenNode
      ? data.outputArtifacts?.scene?.id ?? data.latestArtifactId
      : data.latestArtifactId;
  const outputVersionChoices = spec.outputPorts
    .filter((port) => !port.hidden)
    .map((port) => {
      const history = data.outputArtifactHistory?.[port.id] ?? [];
      if (history.length < 2) return null;
      const selectionKey = `__selectedArtifact__${port.id}`;
      const selectedRaw =
        typeof data.params?.[selectionKey] === "string"
          ? String(data.params[selectionKey]).trim()
          : "__latest__";
      const selectedValue =
        selectedRaw.length > 0 && (selectedRaw === "__latest__" || history.some((entry) => entry.id === selectedRaw))
          ? selectedRaw
          : "__latest__";
      return {
        portId: port.id,
        portLabel: port.label,
        selectionKey,
        selectedValue,
        history
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const nodeStatus = data.status ?? "idle";
  const isRuntimeLocked = Boolean(data.isLockedByRun || nodeStatus === "running");
  const statusFxClass =
    nodeStatus === "success"
      ? "node-success-glow"
      : nodeStatus === "error"
        ? "node-error-glow"
        : nodeStatus === "running"
          ? "shadow-[0_0_0_1px_rgba(120,169,211,0.42),0_12px_34px_rgba(62,118,168,0.24)]"
          : "";

  useEffect(() => {
    if (!isSam2Node) return;
    let mounted = true;
    fetchSam2Configs().then((configs) => {
      if (!mounted) return;
      setSam2CfgOptions(configs);
    });
    return () => {
      mounted = false;
    };
  }, [isSam2Node]);

  useEffect(() => {
    if (!isCustomSceneGenNode) return;
    let mounted = true;
    fetchSam3dConfigs().then((configs) => {
      if (!mounted) return;
      setSam3dCfgOptions(configs);
    });
    return () => {
      mounted = false;
    };
  }, [isCustomSceneGenNode]);

  useEffect(() => {
    if (!shouldLoadSequenceManifest || typeof previewSourceArtifact?.url !== "string") {
      setSequenceManifest(null);
      setSequenceLoading(false);
      setSequenceError(null);
      setSequenceFrameIndex(0);
      setSequencePlaying(false);
      for (const objectUrl of Object.values(sequenceFrameUrlRegistryRef.current)) {
        URL.revokeObjectURL(objectUrl);
      }
      sequenceFrameUrlRegistryRef.current = {};
      setSequenceFrameUrls({});
      return;
    }

    let mounted = true;
    setSequenceLoading(true);
    setSequenceError(null);

    fetch(previewSourceArtifact.url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load sequence manifest (${response.status})`);
        }
        return response.json();
      })
      .then((payload) => {
        if (!mounted) return;
        const normalized = normalizeSequenceManifest(payload);
        if (!normalized) {
          throw new Error("Sequence manifest is invalid.");
        }
        setSequenceManifest(normalized);
        setSequenceFrameIndex(0);
      })
      .catch((error) => {
        if (!mounted) return;
        setSequenceManifest(null);
        setSequenceError(error instanceof Error ? error.message : "Failed to load sequence.");
      })
      .finally(() => {
        if (mounted) {
          setSequenceLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [shouldLoadSequenceManifest, previewSourceArtifact?.url]);

  useEffect(() => {
    return () => {
      for (const objectUrl of Object.values(sequenceFrameUrlRegistryRef.current)) {
        URL.revokeObjectURL(objectUrl);
      }
      sequenceFrameUrlRegistryRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!shouldRenderSequence || sequenceFrames.length === 0) {
      return;
    }

    const activeKey = activeSequenceFrame?.depth_storage_key ?? null;
    const nextKey =
      sequenceFrames.length > 1
        ? sequenceFrames[(clampedSequenceFrameIndex + 1) % sequenceFrames.length]?.depth_storage_key ?? null
        : null;
    const keysToLoad = [activeKey, nextKey]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .filter((value) => !sequenceFrameUrlRegistryRef.current[value]);

    if (keysToLoad.length === 0) {
      return;
    }

    let cancelled = false;

    Promise.all(
      keysToLoad.map(async (storageKey) => {
        const response = await fetch(buildStorageObjectUrl(storageKey), { cache: "force-cache" });
        if (!response.ok) {
          throw new Error(`Failed to load frame (${response.status})`);
        }
        const blob = await response.blob();
        return {
          storageKey,
          objectUrl: URL.createObjectURL(blob)
        };
      })
    )
      .then((entries) => {
        if (cancelled) {
          for (const entry of entries) {
            URL.revokeObjectURL(entry.objectUrl);
          }
          return;
        }
        for (const entry of entries) {
          sequenceFrameUrlRegistryRef.current[entry.storageKey] = entry.objectUrl;
        }
        setSequenceFrameUrls({ ...sequenceFrameUrlRegistryRef.current });
      })
      .catch((error) => {
        if (cancelled) return;
        setSequenceError(error instanceof Error ? error.message : "Failed to load sequence frame.");
        setSequencePlaying(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSequenceFrame?.depth_storage_key, clampedSequenceFrameIndex, sequenceFrames, shouldRenderSequence]);

  useEffect(() => {
    if (!shouldRenderSequence) {
      setSequencePlaying(false);
      return;
    }
    setSequencePlaying(shouldAutoPlaySequence);
  }, [shouldAutoPlaySequence, shouldRenderSequence]);

  useEffect(() => {
    if (!shouldRenderSequence || !sequencePlaying || sequenceFrames.length <= 1) {
      return;
    }
    const intervalMs = Math.max(40, Math.floor(1000 / sequenceFps));
    const timer = window.setInterval(() => {
      setSequenceFrameIndex((current) => {
        if (current >= sequenceFrames.length - 1) {
          if (sequenceLoop) return 0;
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [sequenceFps, sequenceFrames.length, sequenceLoop, sequencePlaying, shouldRenderSequence]);

  useEffect(() => {
    if (!shouldRenderSequence || sequenceLoop || sequenceFrames.length === 0) return;
    if (sequenceFrameIndex >= sequenceFrames.length - 1) {
      setSequencePlaying(false);
    }
  }, [sequenceFrameIndex, sequenceFrames.length, sequenceLoop, shouldRenderSequence]);

  const openPreviewModal = (event: ReactMouseEvent) => {
    if (!hasOpenablePreview) return;
    event.preventDefault();
    event.stopPropagation();
    setPreviewModalOpen(true);
  };

  return (
    <div
      className={cn(
        "relative rounded-[9px] border border-[#494949] bg-[#2f2f2f]/95 p-2.5 text-zinc-100 shadow-[0_8px_22px_rgba(0,0,0,0.55)] motion-fast hover:scale-[1.01] hover:border-[#5b83a8] hover:shadow-[0_0_0_1px_rgba(91,131,168,0.3),0_12px_34px_rgba(0,0,0,0.62)]",
        sizeClass,
        selected && "scale-[1.02] border-[#78a9d3] shadow-[0_0_0_1px_rgba(120,169,211,0.65),0_10px_30px_rgba(0,0,0,0.6)]",
        statusFxClass
      )}
    >
      <NodeResizer
        isVisible={selected && !isRuntimeLocked}
        minWidth={minNodeWidth}
        minHeight={minNodeHeight}
        maxWidth={720}
        maxHeight={900}
        color="#7ba8cf"
        onResize={(_, params) => {
          if (!usesImageSizing) return;
          const changed = Math.abs(params.width - defaultImageWidth) > 6;
          setHasCustomImageWidth((current) => (current === changed ? current : changed));
        }}
        onResizeEnd={(_, params) => {
          if (!usesImageSizing) return;
          setHasCustomImageWidth(Math.abs(params.width - defaultImageWidth) > 6);
        }}
      />

      {(isCustomSceneGenNode ? spec.inputPorts.filter((port) => port.id !== "masksDir") : spec.inputPorts).map((port, idx) => {
        const top = 46 + idx * 20;
        return (
          <div key={`${port.id}-${idx}`}>
            <Handle
              id={port.id}
              type="target"
              position={Position.Left}
              style={{ top, width: 9, height: 9, background: "#d1a03f", border: "1px solid #141414", left: -4.5 }}
            />
            <span
              className={cn(
                "pointer-events-none absolute -left-1 -translate-x-full px-1 py-0.5 text-[10px] text-[#a9a9a9]",
                port.advancedOnly && "opacity-70"
              )}
              style={{ top: top - 8 }}
            >
              {port.label}
            </span>
          </div>
        );
      })}

      <div className="-mx-2.5 -mt-2.5 mb-2 flex items-center justify-between gap-2 rounded-t-[8px] border-b border-[#484848] bg-gradient-to-b from-[#3a3a3a] to-[#333333] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-5 w-5 place-items-center rounded-full border border-[#5b5b5b] bg-[#2c2c2c] text-zinc-300">
            <Icon className="h-3 w-3" />
          </div>
          <div className="min-w-0">
            <h4 className="truncate text-[15px] font-medium leading-tight text-[#dfdfdf]">{spec.title}</h4>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {nodeStatus === "running" ? <span className="h-2 w-2 rounded-full bg-cyan-300 running-pulse" /> : null}
          {tag ? (
            <Badge className="rounded border border-[#525252] bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-zinc-300" variant="secondary">
              {tag}
            </Badge>
          ) : null}
          <Badge className={cn("rounded border px-1.5 py-0.5 text-[10px] capitalize", statusClass[nodeStatus])} variant="secondary">
            {nodeStatus}
          </Badge>
        </div>
      </div>

      {nodeType === "model.sam2" ? (
        <div className="mb-2 rounded-md border border-[#4b5f70] bg-[#24303a] px-2 py-1 text-[10px] text-[#c4d8ea]">
          {(data.runtimeMode ?? sam2ComputedMode) === "guided"
            ? "Guided segmentation (from ObjectDetection)"
            : "Full segmentation"}
        </div>
      ) : null}

      {isSam2Node ? (
        <div className={cn("nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">Mode</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sam2DisplayedMode}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "guided" && !hasSam2BoxesConfig) return;
                data.onUpdateParam?.(id, "mode", next === "guided" ? "guided" : "full");
              }}
            >
              <option
                value="guided"
                disabled={!hasSam2BoxesConfig}
                title={!hasSam2BoxesConfig ? "Requires ObjectDetection descriptor JSON input." : undefined}
              >
                Guided (DINO config)
              </option>
              <option value="full">Full auto segmentation</option>
            </select>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">SegmentScene Config</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sam2Cfg}
              onChange={(event) => data.onUpdateParam?.(id, "sam2Cfg", event.target.value)}
            >
              {sam2CfgOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {isCustomSceneGenNode ? (
        <div className={cn("nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">Config Preset</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={scenePreset}
              onChange={(event) => data.onUpdateParam?.(id, "configPreset", event.target.value)}
            >
              {getSceneGenerationPresetNames().map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">Output Format</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sceneFormat}
              onChange={(event) => data.onUpdateParam?.(id, "format", event.target.value)}
            >
              <option value="mesh_glb">mesh_glb</option>
              <option value="point_ply">point_ply</option>
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">Config</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sceneConfig}
              onChange={(event) => data.onUpdateParam?.(id, "config", event.target.value)}
            >
              {sam3dCfgOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          {sceneFormat === "mesh_glb" ? (
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-400">Mask Execution</p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-[#555] bg-[#1f1f1f] p-1">
                <button
                  type="button"
                  onClick={() => data.onUpdateParam?.(id, "runAllMasksInOneProcess", true)}
                  className={cn(
                    "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                    sceneRunAllMasksInOneProcess
                      ? "border border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border border-transparent text-zinc-300 hover:bg-white/[0.08]"
                  )}
                  title="One process handles all masks."
                >
                  All masks
                </button>
                <button
                  type="button"
                  onClick={() => data.onUpdateParam?.(id, "runAllMasksInOneProcess", false)}
                  className={cn(
                    "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                    !sceneRunAllMasksInOneProcess
                      ? "border border-amber-400/40 bg-amber-500/15 text-amber-200"
                        : "border border-transparent text-zinc-300 hover:bg-white/[0.08]"
                  )}
                  title="Run one process per mask to reduce OOM risk."
                >
                  Per mask
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : isSceneGenerationPipelineNode ? (
        <div className={cn("nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">objectPrompt</p>
            <input
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sceneObjectPrompt}
              onChange={(event) => data.onUpdateParam?.(id, "objectPrompt", event.target.value)}
              placeholder="chair, house, car, tree ..."
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">SceneDetailedOption</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={scenePreset}
              onChange={(event) => data.onUpdateParam?.(id, "SceneDetailedOption", event.target.value)}
            >
              {getSceneGenerationPresetNames().map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">SceneOutputFormat</p>
            <select
              className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
              value={sceneFormat}
              onChange={(event) => data.onUpdateParam?.(id, "SceneOutputFormat", event.target.value)}
            >
              <option value="mesh_glb">mesh_glb</option>
              <option value="point_ply">point_ply</option>
            </select>
          </div>
          {sceneFormat === "mesh_glb" ? (
            <div className="space-y-1">
              <p className="text-[10px] text-zinc-400">Mask Execution</p>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-[#555] bg-[#1f1f1f] p-1">
                <button
                  type="button"
                  onClick={() => data.onUpdateParam?.(id, "SceneMaskExecution", "all_masks")}
                  className={cn(
                    "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                    sceneRunAllMasksInOneProcess
                      ? "border border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                      : "border border-transparent text-zinc-300 hover:bg-white/[0.06]"
                  )}
                  title="One process handles all masks."
                >
                  All masks
                </button>
                <button
                  type="button"
                  onClick={() => data.onUpdateParam?.(id, "SceneMaskExecution", "per_mask")}
                  className={cn(
                    "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                    !sceneRunAllMasksInOneProcess
                      ? "border border-amber-400/40 bg-amber-500/15 text-amber-200"
                      : "border border-transparent text-zinc-300 hover:bg-white/[0.06]"
                  )}
                  title="Run one process per mask to reduce OOM risk."
                >
                  Per mask
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {isGroundingDinoNode ? (
        <div className={cn("nodrag mb-2 space-y-1 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <p className="text-[10px] text-zinc-400">Classes to detect</p>
          <input
            className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
            value={dinoPrompt}
            onChange={(event) => data.onUpdateParam?.(id, "prompt", event.target.value)}
            placeholder="chair, house, car, tree ..."
          />
          {dinoPrompt.trim().length === 0 ? (
            <p className="text-[10px] text-zinc-500">Empty prompt uses DEFAULT_GROUNDING_DINO_CLASSES.</p>
          ) : null}
        </div>
      ) : null}

      {isQwenImageEditNode ? (
        <div className={cn("nodrag mb-2 space-y-1 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <p className="text-[10px] text-zinc-400">Edit prompt</p>
          <textarea
            className="nodrag min-h-[68px] w-full resize-y rounded-md border border-[#555] bg-[#1f1f1f] px-2 py-1.5 text-[10px] text-[#d7d7d7] outline-none"
            value={qwenImageEditPrompt}
            onChange={(event) => data.onUpdateParam?.(id, "prompt", event.target.value)}
            placeholder="Describe the edit to apply..."
          />
        </div>
      ) : null}

      {isInputImageNode ? (
        <div className={cn("mb-2 nodrag rounded-lg border border-white/10 bg-black/25 p-1", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <div className="mb-1 grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => data.onUpdateParam?.(id, "sourceMode", "upload")}
              className={cn(
                "rounded-md px-2 py-1 text-[10px] transition",
                inputImageSourceMode === "upload"
                  ? "border border-sky-400/40 bg-sky-500/15 text-sky-200"
                  : "border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08]"
              )}
            >
              Upload
            </button>
            <button
              type="button"
              onClick={() => {
                data.onUpdateParam?.(id, "sourceMode", "generate");
                if (!inputImageModel) {
                  data.onUpdateParam?.(id, "generatorModel", "Qwen-Distill");
                }
              }}
              className={cn(
                "rounded-md px-2 py-1 text-[10px] transition",
                inputImageSourceMode === "generate"
                  ? "border border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                  : "border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08]"
              )}
            >
              Generate
            </button>
          </div>

          {isImageGenerationNode ? (
            <div className="space-y-1">
              <select
                className="nodrag h-7 w-full rounded-md border border-white/10 bg-black/35 px-2 text-[10px] text-zinc-100 outline-none"
                value={inputImageModel || "Qwen-Distill"}
                onChange={(event) => data.onUpdateParam?.(id, "generatorModel", event.target.value)}
              >
                <option value="Qwen-Distill">Qwen-Distill</option>
                <option value="Z-Image-Turbo">Z-Image-Turbo</option>
              </select>
              <input
                className="nodrag h-7 w-full rounded-md border border-white/10 bg-black/35 px-2 text-[10px] text-zinc-100 outline-none"
                value={inputImagePrompt}
                onChange={(event) => data.onUpdateParam?.(id, "prompt", event.target.value)}
                placeholder="Prompt..."
              />
            </div>
          ) : null}
        </div>
      ) : isInputVideoNode ? (
        <div className={cn("mb-2 nodrag rounded-lg border border-white/10 bg-black/25 p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <p className="text-[10px] text-zinc-400">Upload an MP4 source video for frame-wise depth estimation.</p>
        </div>
      ) : null}

      {isSceneGenerationNode ? (
        <div className="mb-2 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
          <div className="rounded-md border border-[#565656] bg-[#1f1f1f] px-2 py-1.5">
            <p className="text-[11px] text-zinc-300">Output format: {sceneFormat}</p>
            {sceneViewerArtifactId ? (
              <p className="mt-1 truncate text-[10px] text-zinc-500">Artifact #{sceneViewerArtifactId.slice(0, 8)}</p>
            ) : (
              <p className="mt-1 text-[10px] text-zinc-500">
                {isCustomSceneGenNode ? "Run CustomSceneGen to create scene assets." : "Run SceneGeneration to create scene assets."}
              </p>
            )}
          </div>
          <div className="mt-2">
            <button
              type="button"
              className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-[#4f6478] bg-[#253341] px-2 text-[10px] font-medium text-[#c9def1] transition hover:bg-[#2b3d4e] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => data.onOpenViewer?.({ artifactId: sceneViewerArtifactId, nodeId: id })}
              disabled={!sceneViewerArtifactId}
              title={sceneViewerArtifactId ? "Open scene in viewer" : "No scene artifact yet"}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Scene Viewer
            </button>
          </div>
        </div>
      ) : isPreviewNode ? (
        <div className="mb-2 space-y-2">
          <div className={cn("nodrag space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-[10px] text-zinc-400">Preview Mode</p>
                <select
                  className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
                  value={previewMode}
                  onChange={(event) => data.onUpdateParam?.(id, "previewMode", event.target.value)}
                >
                  <option value="auto">Auto</option>
                  <option value="single">Single</option>
                  <option value="sequence">Sequence</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-zinc-400">Fit</p>
                <select
                  className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
                  value={previewFit}
                  onChange={(event) => data.onUpdateParam?.(id, "previewFit", event.target.value)}
                >
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                </select>
              </div>
            </div>

            {hasSequenceManifestArtifact && !shouldPreferVideoPreview ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <p className="text-[10px] text-zinc-400">Playback FPS</p>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    step={1}
                    className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
                    value={sequenceFps}
                    onChange={(event) => data.onUpdateParam?.(id, "sequenceFps", Number(event.target.value) || 1)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-1 self-end">
                  <button
                    type="button"
                    onClick={() => data.onUpdateParam?.(id, "sequenceAutoplay", !sequenceAutoplay)}
                    className={cn(
                      "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                      sequenceAutoplay ? "border border-[#4f6478] bg-[#253341] text-[#c9def1]" : "border border-[#555] bg-[#1f1f1f] text-zinc-300"
                    )}
                  >
                    Autoplay
                  </button>
                  <button
                    type="button"
                    onClick={() => data.onUpdateParam?.(id, "sequenceLoop", !sequenceLoop)}
                    className={cn(
                      "nodrag h-7 rounded-md px-2 text-[10px] font-medium transition",
                      sequenceLoop ? "border border-[#4f6478] bg-[#253341] text-[#c9def1]" : "border border-[#555] bg-[#1f1f1f] text-zinc-300"
                    )}
                  >
                    Loop
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div
            className={cn(
              "rounded-xl border border-white/10 bg-gradient-to-br p-2",
              previewTint[effectiveArtifactKind ?? "image"] ?? "from-sky-500/25 to-cyan-500/20"
            )}
          >
            <div className="relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-black/35">
              {shouldPreferVideoPreview && effectivePreviewUrl ? (
                <video
                  src={effectivePreviewUrl}
                  className="nodrag h-full w-full cursor-zoom-in object-contain"
                  controls
                  muted
                  onDoubleClick={openPreviewModal}
                  title="Double-click to open full size"
                />
              ) : sequenceLoading || (shouldRenderSequence && !activeSequenceFrameUrl && !sequenceError) ? (
                <div className="grid h-full w-full place-items-center bg-black/35">
                  <p className="px-3 text-center text-[10px] text-zinc-400">Loading sequence preview…</p>
                </div>
              ) : shouldRenderSequence && activeSequenceFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeSequenceFrameUrl}
                  alt={`${spec.title} frame ${clampedSequenceFrameIndex + 1}`}
                  className={cn(
                    "nodrag h-full w-full cursor-zoom-in",
                    previewFit === "cover" ? "object-cover" : "object-contain"
                  )}
                  onDoubleClick={openPreviewModal}
                  title="Double-click to open full size"
                />
              ) : effectivePreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={effectivePreviewUrl}
                  alt={`${spec.title} output`}
                  className={cn(
                    "nodrag h-full w-full cursor-zoom-in",
                    previewFit === "cover" ? "object-cover" : "object-contain"
                  )}
                  onDoubleClick={openPreviewModal}
                  title="Double-click to open full size"
                />
              ) : (
                <div className="grid h-full w-full place-items-center bg-black/35">
                  <p className="px-3 text-center text-[10px] text-zinc-400">
                    {sequenceError
                      ? sequenceError
                      : hasSequenceManifestArtifact
                        ? "Sequence manifest loaded, but no frames are available."
                        : "Connect an artifact to preview."}
                  </p>
                </div>
              )}
            </div>

            {!shouldPreferVideoPreview && shouldRenderSequence && sequenceFrames.length > 0 ? (
              <div className="mt-2 space-y-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="nodrag inline-flex h-7 items-center gap-1 rounded-md border border-[#4f6478] bg-[#253341] px-2 text-[10px] font-medium text-[#c9def1] transition hover:bg-[#2b3d4e]"
                    onClick={() => setSequencePlaying((current) => !current)}
                    disabled={previewMode === "single" || sequenceFrames.length <= 1}
                  >
                    {sequencePlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    {sequencePlaying ? "Pause" : "Play"}
                  </button>
                  <button
                    type="button"
                    className="nodrag h-7 rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-zinc-300"
                    onClick={() => {
                      setSequencePlaying(false);
                      setSequenceFrameIndex((current) => Math.max(0, current - 1));
                    }}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="nodrag h-7 rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-zinc-300"
                    onClick={() => {
                      setSequencePlaying(false);
                      setSequenceFrameIndex((current) => Math.min(sequenceFrames.length - 1, current + 1));
                    }}
                  >
                    Next
                  </button>
                  <span className="ml-auto text-[10px] text-zinc-400">
                    Frame {clampedSequenceFrameIndex + 1}/{sequenceFrames.length}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, sequenceFrames.length - 1)}
                  step={1}
                  value={clampedSequenceFrameIndex}
                  onChange={(event) => {
                    setSequencePlaying(false);
                    setSequenceFrameIndex(Number(event.target.value) || 0);
                  }}
                  className="nodrag w-full accent-sky-400"
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : isImageNode ? (
        <div
          className={cn(
            "mb-2 rounded-xl border border-white/10 bg-gradient-to-br p-2",
            previewTint[effectiveArtifactKind ?? "image"] ?? "from-sky-500/25 to-cyan-500/20"
          )}
          onDragOver={
            isInputMediaNode && !isRuntimeLocked
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }
              : undefined
          }
          onDrop={
            isInputMediaNode && !isImageGenerationNode && !isRuntimeLocked
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const file = event.dataTransfer.files?.[0];
                  if (!file) return;
                  data.onUploadImage?.(id, file);
                }
              : undefined
          }
        >
          <div className="relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-black/35">
            {data.status === "running" && isImageGenerationNode ? (
              <div className="relative h-full w-full overflow-hidden bg-black/70">
                <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-emerald-500/20 via-sky-400/25 to-emerald-500/20" />
                <div className="absolute inset-0 animate-pulse bg-gradient-to-tr from-transparent via-white/10 to-transparent" />
                <div className="absolute inset-0 grid place-items-center text-center">
                  <div>
                    <p className="text-[11px] font-medium text-emerald-100">Generating image...</p>
                    <p className="text-[10px] text-zinc-300">{inputImageModel || "Qwen-Distill"}</p>
                  </div>
                </div>
              </div>
            ) : data.status === "running" ? (
              <div className="h-full w-full animate-pulse bg-white/10" />
            ) : effectivePreviewUrl ? (
              isVideoPreview ? (
                <video
                  src={effectivePreviewUrl}
                  className="nodrag h-full w-full cursor-zoom-in object-contain"
                  controls
                  muted
                  onDoubleClick={openPreviewModal}
                  title="Double-click to open full size"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={effectivePreviewUrl}
                  alt={`${spec.title} preview`}
                  className="nodrag h-full w-full cursor-zoom-in object-contain"
                  onDoubleClick={openPreviewModal}
                  title="Double-click to open full size"
                />
              )
            ) : (
              <div className="grid h-full w-full place-items-center bg-black/35">
                <p className="px-3 text-center text-[10px] text-zinc-400">
                  {isImageGenerationNode
                    ? "Choose prompt and run to generate preview."
                    : isPreviewNode
                      ? "Connect an artifact to preview."
                      : isInputVideoNode
                        ? "Upload an MP4 video."
                        : "Upload an image."}
                </p>
              </div>
            )}
            {isInputMediaNode && hasImagePreview && !isImageGenerationNode ? (
              <label
                className={cn(
                  "nodrag absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full border border-white/25 bg-black/70 px-2 py-1 text-[10px] text-zinc-100 transition hover:border-white/40 hover:bg-black/85",
                  isRuntimeLocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                )}
              >
                <UploadCloud className="h-3.5 w-3.5" />
                <span>Replace</span>
                <input
                  type="file"
                  accept={isInputVideoNode ? "video/mp4" : "image/png,image/jpeg,image/webp"}
                  disabled={isRuntimeLocked}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    data.onUploadImage?.(id, file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            ) : null}
          </div>
          <p className="mt-1.5 truncate text-[11px] text-zinc-300">
            {isImageGenerationNode
              ? `${inputImageModel || "Qwen-Distill"}${inputImagePrompt ? ` • ${inputImagePrompt}` : ""}`
              : typeof data.params?.filename === "string" && data.params.filename.length > 0
              ? data.params.filename
              : effectiveArtifactKind
                ? `Output: ${effectiveArtifactKind}`
                : spec.description}
          </p>
          {isInputMediaNode && !hasImagePreview && !isImageGenerationNode ? (
            <div
              className={cn("nodrag mt-2 rounded-lg border border-dashed border-white/20 bg-black/20 p-2 text-center", isRuntimeLocked && "opacity-60")}
            >
              <label className={cn("nodrag inline-flex items-center gap-1 text-[11px] text-zinc-200", isRuntimeLocked ? "cursor-not-allowed" : "cursor-pointer")}>
                <UploadCloud className="h-3.5 w-3.5" />
                <span>{isInputVideoNode ? "Upload / Drop MP4" : "Upload / Drop Image"}</span>
                <input
                  type="file"
                  accept={isInputVideoNode ? "video/mp4" : "image/png,image/jpeg,image/webp"}
                  disabled={isRuntimeLocked}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    data.onUploadImage?.(id, file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          ) : null}
          {isInputMediaNode && hasImagePreview && !isImageGenerationNode ? (
            <p className="mt-1 text-[10px] text-zinc-500">
              {isInputVideoNode ? "Drag and drop to replace video." : "Drag and drop to replace image."}
            </p>
          ) : null}
        </div>
      ) : isTextNode ? (
        <div className="mb-2 rounded-xl border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-zinc-300">
          <p className="max-h-36 overflow-auto whitespace-pre-wrap pr-1 leading-relaxed text-zinc-300">
            {promptText || spec.description}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            "mb-2 rounded-xl border border-white/10 bg-gradient-to-br px-2.5 py-2 text-[11px] text-zinc-300",
            previewTint[effectiveArtifactKind ?? ""] ?? "from-zinc-700/20 to-zinc-800/30"
          )}
        >
          {data.status === "running" ? (
            <div className="space-y-1">
              <div className="h-3 w-24 animate-pulse rounded bg-white/15" />
              <div className="h-3 w-32 animate-pulse rounded bg-white/10" />
            </div>
          ) : effectiveArtifactKind ? (
            <div className="space-y-1">
              <p className="font-medium text-zinc-100">Output: {effectiveArtifactKind}</p>
              <p className="truncate text-zinc-400">Artifact {data.latestArtifactId?.slice(0, 10)}</p>
            </div>
          ) : (
            <p className="line-clamp-3 text-zinc-400">{spec.description}</p>
          )}
        </div>
      )}

      {outputVersionChoices.length > 0 ? (
        <div className={cn("nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2", isRuntimeLocked && "pointer-events-none opacity-60")}>
          <p className="text-[10px] uppercase tracking-[0.08em] text-zinc-400">Output Version</p>
          {outputVersionChoices.map((choice) => (
            <div key={`${id}-${choice.portId}`} className="space-y-1">
              <p className="text-[10px] text-zinc-400">{choice.portLabel}</p>
              <select
                className="nodrag h-7 w-full rounded-md border border-[#555] bg-[#1f1f1f] px-2 text-[10px] text-[#d7d7d7] outline-none"
                value={choice.selectedValue}
                onChange={(event) => data.onUpdateParam?.(id, choice.selectionKey, event.target.value)}
              >
                <option value="__latest__">Latest (auto)</option>
                {choice.history.map((artifact) => (
                  <option key={artifact.id} value={artifact.id}>
                    {formatArtifactVersionLabel(artifact)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}

      {canRunNode ? (
        <button
          type="button"
          onClick={() => data.onRunNode?.(id)}
          disabled={isRuntimeLocked}
          className="mb-2 inline-flex h-7 items-center gap-1 rounded-md border border-[#5f6f53] bg-[#2d3a2a] px-2 text-[10px] font-medium text-[#cfe3c1] transition hover:bg-[#34452f]"
        >
          <Play className="h-3 w-3" />
          {isGroundingDinoNode && dinoHasOutput ? "Rerun" : "Run"}
          {typeof data.runProgress === "number" && data.status === "running" ? <span className="text-emerald-100/80">{data.runProgress}%</span> : null}
        </button>
      ) : null}

      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span className="truncate">
          {data.isCacheHit ? "cache-hit" : spec.icon}
        </span>
        {data.lastRunAt ? (
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            {new Date(data.lastRunAt).toLocaleTimeString()}
          </span>
        ) : null}
        {data.latestArtifactId ? <span>#{data.latestArtifactId.slice(0, 8)}</span> : null}
      </div>

      {(isSam2Node ? spec.outputPorts.filter((port) => port.id === "config") : spec.outputPorts).map((port, idx) => {
        const top = 46 + idx * 20;
        return (
          <div key={`${port.id}-${idx}`}>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              style={{ top, width: 9, height: 9, background: "#66b6ff", border: "1px solid #141414", right: -4.5 }}
            />
            <span
              className={cn(
                "pointer-events-none absolute -right-1 translate-x-full px-1 py-0.5 text-[10px] text-[#a9a9a9]",
                port.hidden && "opacity-70"
              )}
              style={{ top: top - 8 }}
            >
              {port.label}
            </span>
          </div>
        );
      })}

      <Dialog open={previewModalOpen} onOpenChange={setPreviewModalOpen}>
        <DialogContent className="w-[96vw] max-w-[1300px] border-white/15 bg-black/90 p-3 text-zinc-100">
          <div className="mb-2 flex items-center justify-between">
            <DialogTitle className="text-sm font-medium text-zinc-100">{spec.title} Preview</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-white/5 text-zinc-200 transition hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </DialogClose>
          </div>
          <div className="max-h-[82vh] overflow-auto rounded-lg border border-white/10 bg-black/50 p-1">
            {shouldPreferVideoPreview && effectivePreviewUrl ? (
              <video src={effectivePreviewUrl} className="h-auto max-h-[80vh] w-full" controls />
            ) : shouldRenderSequence && activeSequenceFrameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeSequenceFrameUrl}
                alt={`${spec.title} frame ${clampedSequenceFrameIndex + 1}`}
                className={cn("h-auto w-full", previewFit === "cover" ? "object-cover" : "object-contain")}
              />
            ) : effectivePreviewUrl ? (
              isVideoPreview ? (
                <video src={effectivePreviewUrl} className="h-auto max-h-[80vh] w-full" controls />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={effectivePreviewUrl} alt={`${spec.title} full preview`} className="h-auto w-full object-contain" />
              )
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const WorkflowNode = memo(WorkflowNodeImpl);
WorkflowNode.displayName = "WorkflowNode";
