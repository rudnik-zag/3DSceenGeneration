"use client";

import type { ComponentType } from "react";
import { Handle, NodeProps, Position } from "reactflow";
import {
  Boxes,
  Camera,
  FileCode2,
  Image as ImageIcon,
  Layers,
  Sparkles,
  Type as TypeIcon,
  WandSparkles
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { nodeSpecRegistry } from "@/lib/graph/node-specs";
import { cn } from "@/lib/utils";
import { GraphNodeData, WorkflowNodeType } from "@/types/workflow";

const statusClass: Record<string, string> = {
  idle: "border-zinc-700/80 bg-zinc-900/85 text-zinc-300",
  running: "border-sky-500/55 bg-sky-500/15 text-sky-200",
  success: "border-emerald-500/55 bg-emerald-500/15 text-emerald-200",
  error: "border-rose-500/55 bg-rose-500/15 text-rose-200",
  "cache-hit": "border-amber-500/55 bg-amber-500/15 text-amber-200"
};

const previewTint: Record<string, string> = {
  image: "from-sky-500/35 via-cyan-400/20 to-blue-600/25",
  mask: "from-violet-500/25 to-fuchsia-400/20",
  json: "from-zinc-500/20 to-slate-500/20",
  mesh_glb: "from-emerald-500/25 to-teal-400/20",
  point_ply: "from-orange-500/25 to-amber-500/20",
  splat_ksplat: "from-pink-500/25 to-purple-500/20"
};

const nodeIconMap: Partial<Record<WorkflowNodeType, ComponentType<{ className?: string }>>> = {
  "input.image": ImageIcon,
  "input.text": TypeIcon,
  "input.cameraPath": Camera,
  "model.groundingdino": Boxes,
  "model.sam2": Layers,
  "model.sam3d_objects": Layers,
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
  "model.groundingdino": "GroundingDINO",
  "model.sam2": "SAM2",
  "model.sam3d_objects": "SAM3D",
  "model.qwen_vl": "Qwen-VL",
  "model.qwen_image_edit": "Flux 2",
  "model.texturing": "Texturing",
  "geo.depth_estimation": "Depth",
  "geo.pointcloud_from_depth": "Points",
  "geo.mesh_reconstruction": "Mesher",
  "out.export_scene": "Exporter"
};

function pickPromptText(data: GraphNodeData) {
  const value = data.params?.value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const prompt = data.params?.prompt;
  if (typeof prompt === "string" && prompt.trim().length > 0) return prompt.trim();
  return "";
}

export function WorkflowNode({ data, type, selected }: NodeProps<GraphNodeData>) {
  const nodeType = type as WorkflowNodeType;
  const spec = nodeSpecRegistry[nodeType];
  const Icon = nodeIconMap[nodeType] ?? Sparkles;
  const isTextNode = nodeType === "input.text" || (spec.category === "Models" && "prompt" in (data.params ?? {}));
  const isImageNode = nodeType === "input.image" || data.latestArtifactKind === "image";
  const promptText = pickPromptText(data);
  const scale = data.uiScale ?? "balanced";
  const sizeClass =
    scale === "compact"
      ? isTextNode
        ? "min-w-[228px] max-w-[260px]"
        : "min-w-[210px]"
      : scale === "cinematic"
        ? isTextNode
          ? "min-w-[300px] max-w-[360px]"
          : isImageNode
            ? "min-w-[290px]"
            : "min-w-[280px]"
        : isTextNode
          ? "min-w-[260px] max-w-[300px]"
          : isImageNode
            ? "min-w-[250px]"
            : "min-w-[238px]";
  const tag = modelTagMap[nodeType];

  return (
    <div
      className={cn(
        "relative rounded-2xl border border-white/10 bg-[#11131b]/94 p-3 text-zinc-100 shadow-[0_20px_45px_rgba(0,0,0,0.5)] transition",
        sizeClass,
        selected && "border-primary/60 shadow-[0_0_0_2px_rgba(74,222,128,0.35),0_24px_50px_rgba(0,0,0,0.55)]"
      )}
    >
      {spec.inputPorts.map((port, idx) => {
        const top = 46 + idx * 20;
        return (
          <div key={`${port.id}-${idx}`}>
            <Handle
              id={port.id}
              type="target"
              position={Position.Left}
              style={{ top, width: 9, height: 9, background: "#8ab4c7", border: "1px solid #1f2937", left: -4.5 }}
            />
            <span
              className="pointer-events-none absolute -left-1 -translate-x-full rounded-md border border-white/10 bg-black/75 px-1.5 py-0.5 text-[10px] text-zinc-400"
              style={{ top: top - 8 }}
            >
              {port.label}
            </span>
          </div>
        );
      })}

      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-white/5 text-zinc-200">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[10px] uppercase tracking-[0.16em] text-zinc-500">{spec.category}</p>
            <h4 className="truncate text-sm font-medium leading-tight text-zinc-100">{spec.title}</h4>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {tag ? (
            <Badge className="rounded-full border border-white/10 bg-black/35 px-1.5 py-0.5 text-[10px] text-zinc-300" variant="secondary">
              {tag}
            </Badge>
          ) : null}
          <Badge className={cn("rounded-full border px-2 py-0.5 text-[10px] capitalize", statusClass[data.status ?? "idle"])} variant="secondary">
            {data.status ?? "idle"}
          </Badge>
        </div>
      </div>

      {isImageNode ? (
        <div
          className={cn(
            "mb-2 rounded-xl border border-white/10 bg-gradient-to-br p-2",
            previewTint[data.latestArtifactKind ?? "image"] ?? "from-sky-500/25 to-cyan-500/20"
          )}
        >
          <div className="aspect-square rounded-lg border border-white/10 bg-black/35" />
          <p className="mt-1.5 truncate text-[11px] text-zinc-300">
            {typeof data.params?.filename === "string" && data.params.filename.length > 0
              ? data.params.filename
              : data.latestArtifactKind
                ? `Output: ${data.latestArtifactKind}`
                : spec.description}
          </p>
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
            previewTint[data.latestArtifactKind ?? ""] ?? "from-zinc-700/20 to-zinc-800/30"
          )}
        >
          {data.latestArtifactKind ? (
            <div className="space-y-1">
              <p className="font-medium text-zinc-100">Output: {data.latestArtifactKind}</p>
              <p className="truncate text-zinc-400">Artifact {data.latestArtifactId?.slice(0, 10)}</p>
            </div>
          ) : (
            <p className="line-clamp-3 text-zinc-400">{spec.description}</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span className="truncate">{spec.icon}</span>
        {data.latestArtifactId ? <span>#{data.latestArtifactId.slice(0, 8)}</span> : null}
      </div>

      {spec.outputPorts.map((port, idx) => {
        const top = 46 + idx * 20;
        return (
          <div key={`${port.id}-${idx}`}>
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              style={{ top, width: 9, height: 9, background: "#8dc6a2", border: "1px solid #1f2937", right: -4.5 }}
            />
            <span
              className="pointer-events-none absolute -right-1 translate-x-full rounded-md border border-white/10 bg-black/75 px-1.5 py-0.5 text-[10px] text-zinc-400"
              style={{ top: top - 8 }}
            >
              {port.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
