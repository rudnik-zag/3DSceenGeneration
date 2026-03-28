"use client";

import { useEffect, useState, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import { Handle, NodeProps, Position } from "reactflow";
import {
  Boxes,
  Camera,
  Clock3,
  FileCode2,
  Image as ImageIcon,
  Layers,
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
  "viewer.environment": "Lighting",
  "model.groundingdino": "ObjectDetection",
  "model.sam2": "SegmentScene",
  "model.sam3d_objects": "CustomSceneGen",
  "pipeline.scene_generation": "SceneGeneration",
  "model.qwen_vl": "Qwen-VL",
  "model.qwen_image_edit": "Flux 2",
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

export function WorkflowNode({ id, data, type, selected }: NodeProps<GraphNodeData>) {
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const nodeType = type as WorkflowNodeType;
  const spec = nodeSpecRegistry[nodeType];
  const Icon = nodeIconMap[nodeType] ?? Sparkles;
  const isGroundingDinoNode = nodeType === "model.groundingdino";
  const isSam2Node = nodeType === "model.sam2";
  const isCustomSceneGenNode = nodeType === "model.sam3d_objects";
  const isSceneGenerationPipelineNode = nodeType === "pipeline.scene_generation";
  const isSceneGenerationNode = isCustomSceneGenNode || isSceneGenerationPipelineNode;
  const isPreviewNode = nodeType === "out.open_in_viewer";
  const [sam2CfgOptions, setSam2CfgOptions] = useState<string[]>(["sam2.1_hiera_l.yaml"]);
  const [sam3dCfgOptions, setSam3dCfgOptions] = useState<string[]>(["hf"]);
  const isInputImageNode = nodeType === "input.image";
  const inputImageSourceMode =
    isInputImageNode && data.params?.sourceMode === "generate" ? "generate" : "upload";
  const inputImageModel =
    isInputImageNode && typeof data.params?.generatorModel === "string"
      ? data.params.generatorModel
      : "";
  const inputImagePrompt =
    isInputImageNode && typeof data.params?.prompt === "string"
      ? data.params.prompt
      : "";
  const isImageGenerationNode = isInputImageNode && inputImageSourceMode === "generate";
  const isTextNode = nodeType === "input.text";
  const effectivePreviewUrl = data.previewUrl ?? null;
  const effectiveArtifactKind = data.latestArtifactKind;
  const isImageNode = nodeType === "input.image" || isPreviewNode;
  const hasImagePreview = Boolean(data.previewUrl);
  const canRunNode =
    Boolean(data.onRunNode && spec.ui?.nodeRunEnabled) &&
    (!isInputImageNode || (isImageGenerationNode && inputImageModel.trim().length > 0));
  const promptText = pickPromptText(data);
  const scale = data.uiScale ?? "balanced";
  const sizeClass =
    scale === "compact"
      ? isTextNode
        ? "min-w-[228px] max-w-[260px]"
        : isImageNode
          ? "w-[224px] max-w-[224px] min-w-[224px]"
          : "min-w-[210px]"
      : scale === "cinematic"
        ? isTextNode
          ? "min-w-[300px] max-w-[360px]"
          : isImageNode
            ? "w-[296px] max-w-[296px] min-w-[296px]"
            : "min-w-[280px]"
        : isTextNode
          ? "min-w-[260px] max-w-[300px]"
          : isImageNode
            ? "w-[252px] max-w-[252px] min-w-[252px]"
            : "min-w-[238px]";
  const tag = modelTagMap[nodeType];
  const dinoPrompt = isGroundingDinoNode && typeof data.params?.prompt === "string" ? data.params.prompt : "";
  const dinoHasOutput = isGroundingDinoNode && Boolean(data.latestArtifactId);
  const hasOpenablePreview = Boolean(effectivePreviewUrl) && (isPreviewNode || isInputImageNode);
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
  const previewViewerArtifactId =
    isPreviewNode &&
    (effectiveArtifactKind === "mesh_glb" || effectiveArtifactKind === "point_ply" || effectiveArtifactKind === "splat_ksplat")
      ? data.latestArtifactId
      : undefined;
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

  const openPreviewModal = (event: ReactMouseEvent) => {
    if (!hasOpenablePreview) return;
    event.preventDefault();
    event.stopPropagation();
    setPreviewModalOpen(true);
  };

  return (
    <div
      className={cn(
        "relative rounded-[9px] border border-[#494949] bg-[#2f2f2f]/95 p-2.5 text-zinc-100 shadow-[0_8px_22px_rgba(0,0,0,0.55)] transition",
        sizeClass,
        selected && "border-[#78a9d3] shadow-[0_0_0_1px_rgba(120,169,211,0.65),0_10px_30px_rgba(0,0,0,0.6)]"
      )}
    >
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
          {tag ? (
            <Badge className="rounded border border-[#525252] bg-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-zinc-300" variant="secondary">
              {tag}
            </Badge>
          ) : null}
          <Badge className={cn("rounded border px-1.5 py-0.5 text-[10px] capitalize", statusClass[data.status ?? "idle"])} variant="secondary">
            {data.status ?? "idle"}
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
        <div className="nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
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
        <div className="nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
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
        <div className="nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
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
        <div className="nodrag mb-2 space-y-1 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
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

      {isInputImageNode ? (
        <div className="mb-2 nodrag rounded-lg border border-white/10 bg-black/25 p-1">
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
                  data.onUpdateParam?.(id, "generatorModel", "Z-Image-Turbo");
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
                value={inputImageModel || "Z-Image-Turbo"}
                onChange={(event) => data.onUpdateParam?.(id, "generatorModel", event.target.value)}
              >
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
      ) : isImageNode ? (
        <div
          className={cn(
            "mb-2 rounded-xl border border-white/10 bg-gradient-to-br p-2",
            previewTint[effectiveArtifactKind ?? "image"] ?? "from-sky-500/25 to-cyan-500/20"
          )}
          onDragOver={
            isInputImageNode
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }
              : undefined
          }
          onDrop={
            isInputImageNode && !isImageGenerationNode
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
                    <p className="text-[10px] text-zinc-300">{inputImageModel || "Z-Image-Turbo"}</p>
                  </div>
                </div>
              </div>
            ) : data.status === "running" ? (
              <div className="h-full w-full animate-pulse bg-white/10" />
            ) : effectivePreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={effectivePreviewUrl}
                alt={`${spec.title} preview`}
                className="nodrag h-full w-full cursor-zoom-in object-contain"
                onDoubleClick={openPreviewModal}
                title="Double-click to open full size"
              />
            ) : (
              <div className="grid h-full w-full place-items-center bg-black/35">
                <p className="px-3 text-center text-[10px] text-zinc-400">
                  {isImageGenerationNode
                    ? "Choose prompt and run to generate preview."
                    : isPreviewNode
                      ? "Connect an artifact to preview."
                      : "Upload an image."}
                </p>
              </div>
            )}
            {isInputImageNode && hasImagePreview && !isImageGenerationNode ? (
              <label className="nodrag absolute bottom-2 right-2 inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/25 bg-black/70 px-2 py-1 text-[10px] text-zinc-100 transition hover:border-white/40 hover:bg-black/85">
                <UploadCloud className="h-3.5 w-3.5" />
                <span>Replace</span>
                <input
                  type="file"
                  accept="image/*"
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
              ? `${inputImageModel || "Z-Image-Turbo"}${inputImagePrompt ? ` • ${inputImagePrompt}` : ""}`
              : typeof data.params?.filename === "string" && data.params.filename.length > 0
              ? data.params.filename
              : effectiveArtifactKind
                ? `Output: ${effectiveArtifactKind}`
                : spec.description}
          </p>
          {isInputImageNode && !hasImagePreview && !isImageGenerationNode ? (
            <div
              className="nodrag mt-2 rounded-lg border border-dashed border-white/20 bg-black/20 p-2 text-center"
            >
              <label className="nodrag inline-flex cursor-pointer items-center gap-1 text-[11px] text-zinc-200">
                <UploadCloud className="h-3.5 w-3.5" />
                <span>Upload / Drop Image</span>
                <input
                  type="file"
                  accept="image/*"
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
          {isInputImageNode && hasImagePreview && !isImageGenerationNode ? <p className="mt-1 text-[10px] text-zinc-500">Drag and drop to replace image.</p> : null}
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
          ) : isPreviewNode && effectivePreviewUrl ? (
            <div className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={effectivePreviewUrl}
                alt={`${spec.title} output`}
                className="nodrag aspect-video h-full w-full cursor-zoom-in object-cover"
                onDoubleClick={openPreviewModal}
                title="Double-click to open full size"
              />
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

      {isPreviewNode ? (
        <div className="mb-2 space-y-2 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
          <p className="text-[10px] text-zinc-400">
            {data.latestArtifactId
              ? `Connected artifact #${data.latestArtifactId.slice(0, 8)}`
              : "Connect any node output to preview it here."}
          </p>
          <button
            type="button"
            className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-[#4f6478] bg-[#253341] px-2 text-[10px] font-medium text-[#c9def1] transition hover:bg-[#2b3d4e] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => data.onOpenViewer?.({ artifactId: previewViewerArtifactId, nodeId: id })}
            disabled={!previewViewerArtifactId}
            title={previewViewerArtifactId ? "Open connected scene in viewer" : "Viewer opens scene artifacts only"}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open Viewer
          </button>
        </div>
      ) : null}

      {outputVersionChoices.length > 0 ? (
        <div className="nodrag mb-2 space-y-1.5 rounded-md border border-[#4a4a4a] bg-[#262626] p-2">
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
            {effectivePreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={effectivePreviewUrl} alt={`${spec.title} full preview`} className="h-auto w-full object-contain" />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
