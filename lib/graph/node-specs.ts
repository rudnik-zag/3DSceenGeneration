import { z } from "zod";

import { NodeSpecRegistry, WorkflowNodeType } from "@/types/workflow";

const textInput = z.object({ value: z.string().default("") });
const imageInput = z.object({
  sourceMode: z.enum(["upload", "generate"]).default("upload"),
  generatorModel: z.string().default(""),
  prompt: z.string().default(""),
  storageKey: z.string().optional(),
  filename: z.string().default("image.png")
});
const cameraPathInput = z.object({ json: z.string().default("[]") });
const thresholdParams = z.object({ threshold: z.number().min(0).max(1).default(0.35) });
const groundingDinoParams = z.object({
  prompt: z.string().default("person, object"),
  threshold: z.number().min(0).max(1).default(0.35)
});
const sam2Params = z.object({
  threshold: z.number().min(0).max(1).default(0.5)
});
const modelPrompt = z.object({ prompt: z.string().default("") });
const depthParams = z.object({ model: z.string().default("fast-depth") });
const pointcloudParams = z.object({ density: z.number().min(0.1).max(2).default(1) });
const meshReconstructionParams = z.object({ quality: z.string().default("balanced") });
const uvParams = z.object({ padding: z.number().min(1).max(32).default(8) });
const bakeParams = z.object({ resolution: z.number().min(256).max(4096).default(1024) });
const exportParams = z.object({ format: z.enum(["mesh_glb", "point_ply", "splat_ksplat"]).default("mesh_glb") });

function makeSpec(type: WorkflowNodeType, spec: NodeSpecRegistry[WorkflowNodeType]) {
  return [type, spec] as const;
}

export const nodeSpecEntries = [
  makeSpec("input.image", {
    type: "input.image",
    category: "Inputs",
    title: "Input Image",
    icon: "Image",
    description: "Upload or reference a source image.",
    inputPorts: [],
    outputPorts: [{ id: "image", label: "Image", payload: "Image" }],
    paramSchema: imageInput,
    paramFields: [
      { key: "sourceMode", label: "Source Mode", input: "select", options: ["upload", "generate"] },
      { key: "generatorModel", label: "Generator Model", input: "select", options: ["Z-Image-Turbo"] },
      { key: "prompt", label: "Generate Prompt", input: "textarea", placeholder: "Cinematic lighting, detailed scene..." },
      { key: "filename", label: "Filename", input: "text" },
      { key: "storageKey", label: "Storage Key", input: "text", placeholder: "projects/..." }
    ],
    defaultParams: { sourceMode: "upload", generatorModel: "Z-Image-Turbo", prompt: "", filename: "image.png", storageKey: "" },
    ui: {
      previewOutputIds: ["image"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("input.text", {
    type: "input.text",
    category: "Inputs",
    title: "Input Text",
    icon: "Type",
    description: "Prompt or instructions.",
    inputPorts: [],
    outputPorts: [{ id: "text", label: "Text", payload: "Text" }],
    paramSchema: textInput,
    paramFields: [{ key: "value", label: "Text", input: "textarea" }],
    defaultParams: { value: "Describe a stylized courtyard." }
  }),
  makeSpec("input.cameraPath", {
    type: "input.cameraPath",
    category: "Inputs",
    title: "Camera Path",
    icon: "Camera",
    description: "JSON camera trajectory.",
    inputPorts: [],
    outputPorts: [{ id: "path", label: "Path", payload: "Json" }],
    paramSchema: cameraPathInput,
    paramFields: [{ key: "json", label: "Camera JSON", input: "json" }],
    defaultParams: { json: "[]" }
  }),
  makeSpec("model.groundingdino", {
    type: "model.groundingdino",
    category: "Models",
    title: "GroundingDINO",
    icon: "Scan",
    description: "Open-vocabulary detection.",
    inputPorts: [{ id: "image", label: "Image", payload: "Image", required: true }],
    outputPorts: [
      { id: "boxes", label: "Boxes JSON", payload: "BoxesJson", hidden: true, advancedOnly: true },
      { id: "overlay", label: "Overlay", payload: "OverlayImage" }
    ],
    paramSchema: groundingDinoParams,
    paramFields: [
      { key: "prompt", label: "Detect Prompt", input: "textarea", placeholder: "person, chair, table" },
      { key: "threshold", label: "Threshold", input: "number" }
    ],
    defaultParams: { prompt: "person, object", threshold: 0.35 },
    ui: {
      previewOutputIds: ["overlay"],
      hiddenOutputIds: ["boxes"],
      advancedOutputIds: ["boxes"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.sam2", {
    type: "model.sam2",
    category: "Models",
    title: "SAM2",
    icon: "Layers",
    description: "Segmentation masks from prompts.",
    inputPorts: [
      { id: "image", label: "Image", payload: "Image", required: true },
      { id: "boxes", label: "Boxes JSON", payload: "BoxesJson", advancedOnly: true }
    ],
    outputPorts: [
      { id: "mask", label: "Mask", payload: "MaskImage" },
      { id: "overlay", label: "Overlay", payload: "OverlayImage" },
      { id: "meta", label: "JSON Meta", payload: "JsonMeta", hidden: true, advancedOnly: true }
    ],
    paramSchema: sam2Params,
    paramFields: [{ key: "threshold", label: "Threshold", input: "number" }],
    defaultParams: { threshold: 0.5 },
    ui: {
      previewOutputIds: ["mask", "overlay"],
      hiddenOutputIds: ["meta"],
      advancedOutputIds: ["meta"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.sam3d_objects", {
    type: "model.sam3d_objects",
    category: "Models",
    title: "SAM3D Objects",
    icon: "Box",
    description: "3D object-aware segmentation.",
    inputPorts: [
      { id: "image", label: "Image", payload: "Image", required: true },
      { id: "mask", label: "Mask", payload: "Mask" }
    ],
    outputPorts: [{ id: "json", label: "Objects", payload: "Json" }],
    paramSchema: z.object({ mode: z.enum(["fast", "quality"]).default("fast") }),
    paramFields: [{ key: "mode", label: "Mode", input: "select", options: ["fast", "quality"] }],
    defaultParams: { mode: "fast" }
  }),
  makeSpec("model.qwen_vl", {
    type: "model.qwen_vl",
    category: "Models",
    title: "Qwen-VL",
    icon: "MessageSquare",
    description: "Vision-language reasoning.",
    inputPorts: [
      { id: "image", label: "Image", payload: "Image", required: true },
      { id: "text", label: "Prompt", payload: "Text" }
    ],
    outputPorts: [{ id: "json", label: "Analysis", payload: "Json" }],
    paramSchema: modelPrompt,
    paramFields: [{ key: "prompt", label: "Prompt", input: "textarea" }],
    defaultParams: { prompt: "Describe composition and salient objects." }
  }),
  makeSpec("model.qwen_image_edit", {
    type: "model.qwen_image_edit",
    category: "Models",
    title: "Qwen Image Edit",
    icon: "Wand",
    description: "Prompt-guided image edit.",
    inputPorts: [
      { id: "image", label: "Image", payload: "Image", required: true },
      { id: "text", label: "Prompt", payload: "Text" }
    ],
    outputPorts: [{ id: "image", label: "Edited", payload: "Image" }],
    paramSchema: modelPrompt,
    paramFields: [{ key: "prompt", label: "Edit Prompt", input: "textarea" }],
    defaultParams: { prompt: "Enhance texture details." }
  }),
  makeSpec("model.texturing", {
    type: "model.texturing",
    category: "Models",
    title: "Texturing",
    icon: "Paintbrush",
    description: "Generate texture set for mesh.",
    inputPorts: [
      { id: "mesh", label: "Mesh", payload: "Mesh", required: true },
      { id: "text", label: "Style", payload: "Text" }
    ],
    outputPorts: [{ id: "textures", label: "Texture Set", payload: "TextureSet" }],
    paramSchema: z.object({ style: z.string().default("photoreal") }),
    paramFields: [{ key: "style", label: "Style", input: "text" }],
    defaultParams: { style: "photoreal" }
  }),
  makeSpec("geo.depth_estimation", {
    type: "geo.depth_estimation",
    category: "Geometry",
    title: "Depth Estimation",
    icon: "Mountain",
    description: "Estimate depth from RGB image.",
    inputPorts: [{ id: "image", label: "Image", payload: "Image", required: true }],
    outputPorts: [{ id: "depth", label: "Depth", payload: "Depth" }],
    paramSchema: depthParams,
    paramFields: [{ key: "model", label: "Model", input: "text" }],
    defaultParams: { model: "fast-depth" }
  }),
  makeSpec("geo.pointcloud_from_depth", {
    type: "geo.pointcloud_from_depth",
    category: "Geometry",
    title: "Depth to Point Cloud",
    icon: "Sparkles",
    description: "Back-project depth map into point cloud.",
    inputPorts: [
      { id: "depth", label: "Depth", payload: "Depth", required: true },
      { id: "image", label: "Color", payload: "Image" }
    ],
    outputPorts: [{ id: "pointcloud", label: "Point Cloud", payload: "PointCloud" }],
    paramSchema: pointcloudParams,
    paramFields: [{ key: "density", label: "Density", input: "number" }],
    defaultParams: { density: 1 }
  }),
  makeSpec("geo.mesh_reconstruction", {
    type: "geo.mesh_reconstruction",
    category: "Geometry",
    title: "Mesh Reconstruction",
    icon: "Cube",
    description: "Build watertight mesh from points.",
    inputPorts: [{ id: "pointcloud", label: "Point Cloud", payload: "PointCloud", required: true }],
    outputPorts: [{ id: "mesh", label: "Mesh", payload: "Mesh" }],
    paramSchema: meshReconstructionParams,
    paramFields: [
      { key: "quality", label: "Quality", input: "select", options: ["fast", "balanced", "quality"] }
    ],
    defaultParams: { quality: "balanced" }
  }),
  makeSpec("geo.uv_unwrap", {
    type: "geo.uv_unwrap",
    category: "Geometry",
    title: "UV Unwrap",
    icon: "WrapText",
    description: "Compute UV layout.",
    inputPorts: [{ id: "mesh", label: "Mesh", payload: "Mesh", required: true }],
    outputPorts: [{ id: "mesh", label: "UV Mesh", payload: "Mesh" }],
    paramSchema: uvParams,
    paramFields: [{ key: "padding", label: "Padding", input: "number" }],
    defaultParams: { padding: 8 }
  }),
  makeSpec("geo.bake_textures", {
    type: "geo.bake_textures",
    category: "Geometry",
    title: "Bake Textures",
    icon: "Palette",
    description: "Bake mesh textures.",
    inputPorts: [
      { id: "mesh", label: "Mesh", payload: "Mesh", required: true },
      { id: "textures", label: "Textures", payload: "TextureSet" }
    ],
    outputPorts: [{ id: "textures", label: "Baked Textures", payload: "TextureSet" }],
    paramSchema: bakeParams,
    paramFields: [{ key: "resolution", label: "Resolution", input: "number" }],
    defaultParams: { resolution: 1024 }
  }),
  makeSpec("out.export_scene", {
    type: "out.export_scene",
    category: "Outputs",
    title: "Export Scene",
    icon: "Download",
    description: "Export to GLB, PLY, or splat.",
    inputPorts: [
      { id: "mesh", label: "Mesh", payload: "Mesh" },
      { id: "pointcloud", label: "Point Cloud", payload: "PointCloud" },
      { id: "textures", label: "Textures", payload: "TextureSet" }
    ],
    outputPorts: [{ id: "scene", label: "Scene", payload: "Scene" }],
    paramSchema: exportParams,
    paramFields: [{ key: "format", label: "Format", input: "select", options: ["mesh_glb", "point_ply", "splat_ksplat"] }],
    defaultParams: { format: "mesh_glb" }
  }),
  makeSpec("out.open_in_viewer", {
    type: "out.open_in_viewer",
    category: "Outputs",
    title: "Open In Viewer",
    icon: "ExternalLink",
    description: "Emit viewer link payload.",
    inputPorts: [{ id: "scene", label: "Scene", payload: "Scene", required: true }],
    outputPorts: [{ id: "json", label: "Viewer Link", payload: "Json" }],
    paramSchema: z.object({}),
    paramFields: [],
    defaultParams: {}
  })
] as const;

export const nodeSpecRegistry: NodeSpecRegistry = Object.fromEntries(nodeSpecEntries) as NodeSpecRegistry;

export const allNodeTypes = Object.keys(nodeSpecRegistry) as WorkflowNodeType[];

export const nodeGroups = Object.values(nodeSpecRegistry).reduce<Record<string, (typeof nodeSpecRegistry)[WorkflowNodeType][]>>(
  (acc, spec) => {
    if (!acc[spec.category]) {
      acc[spec.category] = [];
    }
    acc[spec.category].push(spec);
    return acc;
  },
  {}
);
