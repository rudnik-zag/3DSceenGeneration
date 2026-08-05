import { z } from "zod";

import {
  applySceneGenerationPreset,
  getSceneGenerationPresetNames,
  mergeSceneGenerationParams,
  sceneGenerationDefaultParams
} from "@/lib/graph/scene-generation-presets";
import { NodeSpecRegistry, WorkflowNodeType } from "@/types/workflow";

const MAX_COMFY_SEED = Number.MAX_SAFE_INTEGER;

const textInput = z.object({ value: z.string().max(16_000).default("") });
const imageInput = z.object({
  sourceMode: z.enum(["upload", "generate"]).default("upload"),
  generatorModel: z.string().max(120).default(""),
  prompt: z.string().max(16_000).default(""),
  negativePrompt: z.string().max(16_000).default(""),
  seed: z.number().int().min(-1).max(MAX_COMFY_SEED).default(-1),
  steps: z.number().int().min(1).max(150).default(20),
  cfg: z.number().min(1).max(30).default(8),
  width: z.number().int().min(256).max(2048).default(1024),
  height: z.number().int().min(256).max(2048).default(1024),
  sampler: z.string().max(120).default("euler"),
  scheduler: z.string().max(120).default("normal"),
  checkpoint: z.string().max(512).default(""),
  storageKey: z.string().max(1024).optional(),
  filename: z.string().max(260).default("image.png")
});
const videoInput = z.object({
  filename: z.string().max(260).default("input.mp4"),
  storageKey: z.string().max(1024).default(""),
  uploadAssetId: z.string().max(120).optional()
});
const cameraPathInput = z.object({ json: z.string().max(256_000).default("[]") });
const previewNodeParams = z.object({
  previewMode: z.enum(["auto", "single", "sequence"]).default("auto"),
  sequenceFps: z.number().int().min(1).max(60).default(12),
  sequenceLoop: z.boolean().default(true),
  sequenceAutoplay: z.boolean().default(false),
  previewFit: z.enum(["contain", "cover"]).default("contain")
});
const viewerEnvironmentParams = z.object({
  enabled: z.boolean().default(true),
  hdriUrl: z.string().max(2048).default(""),
  hdriStorageKey: z.string().max(1024).default(""),
  backgroundMode: z.enum(["solid", "hdri", "transparent"]).default("solid"),
  backgroundColor: z.string().max(32).default("#05070e"),
  toneMapping: z.enum(["ACESFilmic", "Neutral", "Reinhard", "None"]).default("ACESFilmic"),
  exposure: z.number().min(0).max(6).default(1),
  envIntensity: z.number().min(0).max(8).default(1),
  hdriRotationY: z.number().min(-180).max(180).default(0),
  hdriBlur: z.number().min(0).max(1).default(0),
  ambientIntensity: z.number().min(0).max(8).default(1.1),
  sunIntensity: z.number().min(0).max(8).default(1.2),
  sunColor: z.string().max(32).default("#ffffff"),
  groundColor: z.string().max(32).default("#101828")
});
const groundingDinoParams = z.object({
  prompt: z.string().max(4000).default(""),
  threshold: z.number().min(0).max(1).default(0.35),
  textThreshold: z.number().min(0).max(1).default(0.25),
  tokenSpans: z.string().max(4000).default("")
});
const sam2Params = z.object({
  mode: z.enum(["auto", "guided", "full"]).default("auto"),
  sam2Cfg: z.string().max(512).default("sam2.1_hiera_l.yaml"),
  pointsPerSide: z.number().int().min(4).max(256).default(64),
  predIouThresh: z.number().min(0).max(1).default(0.7),
  stabilityScoreThresh: z.number().min(0).max(1).default(0.9),
  cropNLayers: z.number().int().min(0).max(8).default(1),
  overlayAlpha: z.number().min(0).max(1).default(0.6)
});
const sceneGenerationParams = z.object({
  configPreset: z.enum(["Default", "HighQuality", "FastPreview", "Custom"]).default("Default"),
  format: z.enum(["mesh_glb", "point_ply"]).default("mesh_glb"),
  config: z.string().max(512).default("hf"),
  runAllMasksInOneProcess: z.boolean().default(true),
  maxObjects: z.number().int().min(0).max(128).default(0),
  enableMesh: z.boolean().default(true),
  exportMeshGlb: z.boolean().default(true),
  enableMeshScene: z.boolean().default(true),
  meshPostprocess: z.boolean().default(false),
  textureBaking: z.boolean().default(false),
  decodeMesh: z.boolean().default(true),
  stage1Steps: z.number().int().min(0).max(200).default(0),
  stage2Steps: z.number().int().min(0).max(200).default(0),
  fallbackStage1Steps: z.number().int().min(1).max(200).default(15),
  fallbackStage2Steps: z.number().int().min(1).max(200).default(15),
  autocast: z.boolean().default(false),
  autocastPreferBf16: z.boolean().default(false),
  storeOnCpu: z.boolean().default(true)
});
const sceneGenerationTemplateParams = z.object({
  objectPrompt: z.string().max(4000).default(""),
  SceneDetailedOption: z.enum(["Default", "HighQuality", "FastPreview", "Custom"]).default("Default"),
  SceneOutputFormat: z.enum(["mesh_glb", "point_ply"]).default("mesh_glb"),
  SceneMaskExecution: z.enum(["all_masks", "per_mask"]).default("all_masks"),
  ScenePreviewStage: z.enum(["final", "detection", "segmentation"]).default("final")
});
const modelPrompt = z.object({ prompt: z.string().max(16_000).default("") });
const qwenImageEditParams = z.object({
  prompt: z.string().max(16_000).default(""),
  negativePrompt: z.string().max(16_000).default(""),
  enableTurboMode: z.boolean().default(false),
  referenceLatentsMethod: z.enum(["offset", "index", "uxo/uno", "index_timestep_zero"]).default("index_timestep_zero"),
  seed: z.number().int().min(-1).max(MAX_COMFY_SEED).default(-1),
  steps: z.number().int().min(1).max(150).default(40),
  cfg: z.number().min(0.1).max(30).default(4),
  sampler: z.string().max(120).default("euler"),
  scheduler: z.string().max(120).default("simple"),
  denoise: z.number().min(0).max(1).default(1)
});
const depthParams = z.object({
  modelVariant: z.enum(["da3-base", "da3metric-large"]).default("da3-base"),
  device: z.enum(["auto", "cuda", "cpu"]).default("auto"),
  exportConfidence: z.boolean().default(true),
  exportSky: z.boolean().default(true),
  saveNpz: z.boolean().default(false),
  exportGlb: z.boolean().default(true),
  numMaxPoints: z.number().int().min(1).max(5_000_000).default(1_000_000),
  confThreshPercentile: z.number().min(0).max(100).default(40),
  showCameras: z.boolean().default(false),
  useRayPose: z.boolean().default(false),
  refViewStrategy: z.enum(["saddle_balanced", "first"]).default("saddle_balanced"),
  frameStride: z.number().int().min(1).max(120).default(1),
  maxFrames: z.number().int().min(1).max(2048).default(32),
  resizeLongEdge: z.number().int().min(0).max(4096).default(0)
});
const pointcloudParams = z.object({
  density: z.number().min(0.1).max(2).default(1),
  depthScale: z.number().min(0.01).max(100).default(1)
});
const meshReconstructionParams = z.object({ quality: z.string().max(120).default("balanced") });
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
    description: "Upload/reference a source image or generate one with Comfy-backed text-to-image models.",
    inputPorts: [],
    outputPorts: [{ id: "image", label: "Image", artifactType: "Image" }],
    paramSchema: imageInput,
    paramFields: [
      { key: "sourceMode", label: "Source Mode", input: "select", options: ["upload", "generate"] },
      {
        key: "generatorModel",
        label: "Generator Model",
        input: "select",
        options: ["Qwen-Distill", "Z-Image-Turbo"]
      },
      { key: "prompt", label: "Generate Prompt", input: "textarea", placeholder: "Describe the target image..." },
      { key: "negativePrompt", label: "Negative Prompt", input: "textarea", placeholder: "blurry, low quality, artifacts" },
      { key: "seed", label: "Seed (-1 random)", input: "number", min: -1, max: MAX_COMFY_SEED, step: 1 },
      { key: "steps", label: "Steps", input: "number", min: 1, max: 150, step: 1 },
      { key: "cfg", label: "CFG", input: "number", min: 1, max: 30, step: 0.5 },
      { key: "width", label: "Width", input: "number", min: 256, max: 2048, step: 64 },
      { key: "height", label: "Height", input: "number", min: 256, max: 2048, step: 64 },
      {
        key: "sampler",
        label: "Sampler",
        input: "select",
        options: [
          "res_multistep",
          "euler",
          "euler_ancestral",
          "heun",
          "dpm_2",
          "dpm_2_ancestral",
          "lms",
          "dpm_fast",
          "dpm_adaptive",
          "dpmpp_2s_ancestral",
          "dpmpp_sde",
          "dpmpp_2m",
          "dpmpp_2m_sde",
          "ddim",
          "uni_pc",
          "uni_pc_bh2"
        ]
      },
      {
        key: "scheduler",
        label: "Scheduler",
        input: "select",
        options: ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"]
      },
      { key: "checkpoint", label: "Checkpoint Override", input: "text", placeholder: "z_image_turbo_bf16.safetensors" },
      { key: "filename", label: "Filename", input: "text" },
      { key: "storageKey", label: "Storage Key", input: "text", placeholder: "projects/..." }
    ],
    defaultParams: {
      sourceMode: "upload",
      generatorModel: "Qwen-Distill",
      prompt: "",
      negativePrompt: "",
      seed: -1,
      steps: 10,
      cfg: 1,
      width: 1328,
      height: 1328,
      sampler: "res_multistep",
      scheduler: "simple",
      checkpoint: "",
      filename: "image.png",
      storageKey: ""
    },
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
    outputPorts: [{ id: "text", label: "Text", artifactType: "JsonData" }],
    paramSchema: textInput,
    paramFields: [{ key: "value", label: "Text", input: "textarea" }],
    defaultParams: { value: "Describe a stylized courtyard." }
  }),
  makeSpec("input.video", {
    type: "input.video",
    category: "Inputs",
    title: "Input Video",
    icon: "Film",
    description: "Upload/reference an MP4 source video.",
    inputPorts: [],
    outputPorts: [{ id: "video", label: "Video", artifactType: "Video" }],
    paramSchema: videoInput,
    paramFields: [
      { key: "filename", label: "Filename", input: "text" },
      { key: "storageKey", label: "Storage Key", input: "text", placeholder: "projects/..." }
    ],
    defaultParams: {
      filename: "input.mp4",
      storageKey: ""
    }
  }),
  makeSpec("input.cameraPath", {
    type: "input.cameraPath",
    category: "Inputs",
    title: "Camera Path",
    icon: "Camera",
    description: "JSON camera trajectory.",
    inputPorts: [],
    outputPorts: [{ id: "path", label: "Path", artifactType: "JsonData" }],
    paramSchema: cameraPathInput,
    paramFields: [{ key: "json", label: "Camera JSON", input: "json" }],
    defaultParams: { json: "[]" }
  }),
  makeSpec("viewer.environment", {
    type: "viewer.environment",
    category: "Outputs",
    title: "ViewerEnvironment",
    icon: "Sun",
    description: "Configure viewer lighting and optional HDRI map.",
    inputPorts: [],
    outputPorts: [{ id: "environment", label: "environment", artifactType: "JsonData" }],
    paramSchema: viewerEnvironmentParams,
    paramFields: [
      { key: "enabled", label: "Enabled", input: "boolean" },
      { key: "hdriUrl", label: "HDRI URL", input: "text", placeholder: "https://.../studio.hdr or studio.exr" },
      { key: "hdriStorageKey", label: "HDRI Storage Key", input: "text", placeholder: "projects/.../studio.hdr" },
      { key: "backgroundMode", label: "Background Mode", input: "select", options: ["solid", "hdri", "transparent"] },
      { key: "backgroundColor", label: "Background Color", input: "text", placeholder: "#05070e" },
      { key: "toneMapping", label: "Tone Mapping", input: "select", options: ["ACESFilmic", "Neutral", "Reinhard", "None"] },
      { key: "exposure", label: "Exposure", input: "number", min: 0, max: 6, step: 0.05 },
      { key: "envIntensity", label: "Env Intensity", input: "number", min: 0, max: 8, step: 0.05 },
      { key: "hdriRotationY", label: "HDRI Rotation Y (deg)", input: "number", min: -180, max: 180, step: 1 },
      { key: "hdriBlur", label: "HDRI Blur", input: "number", min: 0, max: 1, step: 0.01 },
      { key: "ambientIntensity", label: "Ambient Intensity", input: "number", min: 0, max: 8, step: 0.05 },
      { key: "sunIntensity", label: "Sun Intensity", input: "number", min: 0, max: 8, step: 0.05 },
      { key: "sunColor", label: "Sun Color", input: "text", placeholder: "#ffffff" },
      { key: "groundColor", label: "Ground Color", input: "text", placeholder: "#101828" }
    ],
    defaultParams: {
      enabled: true,
      hdriUrl: "",
      hdriStorageKey: "",
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
    },
    ui: {
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.groundingdino", {
    type: "model.groundingdino",
    category: "Models",
    title: "ObjectDetection",
    icon: "Scan",
    description: "Open-vocabulary detection.",
    inputPorts: [{ id: "image", label: "Image", artifactType: "Image", required: true }],
    outputPorts: [{ id: "descriptor", label: "descriptor", artifactType: "Descriptor" }],
    paramSchema: groundingDinoParams,
    paramFields: [
      {
        key: "prompt",
        label: "Detect Prompt",
        input: "textarea",
        placeholder: "Optional. If empty, DEFAULT_GROUNDING_DINO_CLASSES from Python script is used."
      },
      { key: "threshold", label: "Threshold", input: "number" }
    ],
    defaultParams: { prompt: "", threshold: 0.35 },
    ui: {
      previewOutputIds: ["descriptor"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.sam2", {
    type: "model.sam2",
    category: "Models",
    title: "SegmentScene",
    icon: "Layers",
    description: "Segmentation masks from prompts.",
    inputPorts: [
      { id: "image", label: "Image", artifactType: "Image", required: true },
      { id: "descriptor", label: "descriptor", artifactType: "Descriptor", advancedOnly: true }
    ],
    outputPorts: [
      { id: "config", label: "MaskSet", artifactType: "MaskSet" },
      { id: "image", label: "Input Image", artifactType: "Image", hidden: true, advancedOnly: true },
      { id: "masksDir", label: "Masks Dir", artifactType: "MaskSet", hidden: true, advancedOnly: true },
      { id: "overlay", label: "Overlay", artifactType: "Image", hidden: true, advancedOnly: true },
      { id: "meta", label: "JSON Meta", artifactType: "JsonData", hidden: true, advancedOnly: true }
    ],
    paramSchema: sam2Params,
    paramFields: [
      { key: "pointsPerSide", label: "Points Per Side", input: "number", min: 4, max: 256, step: 1 },
      { key: "predIouThresh", label: "Pred IoU Thresh", input: "number", min: 0, max: 1, step: 0.01 },
      { key: "stabilityScoreThresh", label: "Stability Score Thresh", input: "number", min: 0, max: 1, step: 0.01 },
      { key: "cropNLayers", label: "Crop N Layers", input: "number", min: 0, max: 8, step: 1 },
      { key: "overlayAlpha", label: "Overlay Alpha", input: "number", min: 0, max: 1, step: 0.05 }
    ],
    defaultParams: {
      mode: "auto",
      sam2Cfg: "sam2.1_hiera_l.yaml",
      pointsPerSide: 64,
      predIouThresh: 0.7,
      stabilityScoreThresh: 0.9,
      cropNLayers: 1,
      overlayAlpha: 0.6
    },
    ui: {
      previewOutputIds: ["overlay", "config"],
      hiddenOutputIds: ["image", "masksDir", "overlay", "meta"],
      advancedOutputIds: ["image", "masksDir", "overlay", "meta"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.sam3d_objects", {
    type: "model.sam3d_objects",
    category: "Models",
    title: "CustomSceneGen",
    icon: "Box",
    description: "Low-level scene generation from SegmentScene outputs.",
    inputPorts: [
      { id: "config", label: "MaskSet", artifactType: "MaskSet", required: true },
      { id: "masksDir", label: "Masks Dir (legacy)", artifactType: "MaskSet", hidden: true, advancedOnly: true }
    ],
    outputPorts: [
      { id: "scene", label: "Scene", artifactType: "SceneAsset" },
      { id: "meta", label: "JSON Meta", artifactType: "JsonData", hidden: true, advancedOnly: true }
    ],
    paramSchema: sceneGenerationParams,
    paramFields: [
      { key: "configPreset", label: "Config Preset", input: "select", options: getSceneGenerationPresetNames() },
      { key: "format", label: "Output Format", input: "select", options: ["mesh_glb", "point_ply"] },
      { key: "config", label: "Config", input: "select", options: ["hf"] },
      { key: "runAllMasksInOneProcess", label: "Run All Masks In One Process", input: "boolean" },
      { key: "maxObjects", label: "Max Objects", input: "number", min: 0, max: 128, step: 1 },
      { key: "enableMesh", label: "Enable Mesh", input: "boolean" },
      { key: "exportMeshGlb", label: "Export Mesh GLB", input: "boolean" },
      { key: "enableMeshScene", label: "Enable Mesh Scene", input: "boolean" },
      { key: "meshPostprocess", label: "Mesh Postprocess", input: "boolean" },
      { key: "textureBaking", label: "Texture Baking", input: "boolean" },
      { key: "decodeMesh", label: "Decode Mesh", input: "boolean" },
      { key: "stage1Steps", label: "Stage1 Steps", input: "number", min: 0, max: 200, step: 1 },
      { key: "stage2Steps", label: "Stage2 Steps", input: "number", min: 0, max: 200, step: 1 },
      { key: "fallbackStage1Steps", label: "Fallback Stage1", input: "number", min: 1, max: 200, step: 1 },
      { key: "fallbackStage2Steps", label: "Fallback Stage2", input: "number", min: 1, max: 200, step: 1 },
      { key: "autocast", label: "Autocast", input: "boolean" },
      { key: "autocastPreferBf16", label: "Prefer BF16", input: "boolean" },
      { key: "storeOnCpu", label: "Store On CPU", input: "boolean" }
    ],
    defaultParams: sceneGenerationDefaultParams,
    ui: {
      previewOutputIds: ["scene"],
      hiddenOutputIds: ["meta"],
      advancedOutputIds: ["meta"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("pipeline.scene_generation", {
    type: "pipeline.scene_generation",
    category: "Models",
    title: "SceneGeneration",
    icon: "Workflow",
    description: "High-level hidden pipeline: ObjectDetection -> SegmentScene -> CustomSceneGen.",
    inputPorts: [{ id: "image", label: "image", artifactType: "Image", required: true }],
    outputPorts: [{ id: "generatedScene", label: "GeneratedScene", artifactType: "SceneAsset" }],
    paramSchema: sceneGenerationTemplateParams,
    paramFields: [
      { key: "objectPrompt", label: "objectPrompt", input: "textarea", placeholder: "chair, house, car, tree" },
      { key: "SceneDetailedOption", label: "SceneDetailedOption", input: "select", options: getSceneGenerationPresetNames() },
      { key: "SceneOutputFormat", label: "SceneOutputFormat", input: "select", options: ["mesh_glb", "point_ply"] },
      { key: "SceneMaskExecution", label: "SceneMaskExecution", input: "select", options: ["all_masks", "per_mask"] },
      { key: "ScenePreviewStage", label: "ScenePreviewStage", input: "select", options: ["final", "detection", "segmentation"] }
    ],
    defaultParams: {
      objectPrompt: "",
      SceneDetailedOption: "Default",
      SceneOutputFormat: "mesh_glb",
      SceneMaskExecution: "all_masks",
      ScenePreviewStage: "final"
    },
    ui: {
      previewOutputIds: ["generatedScene"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.qwen_vl", {
    type: "model.qwen_vl",
    category: "Models",
    title: "Qwen-VL",
    icon: "MessageSquare",
    description: "Vision-language reasoning.",
    inputPorts: [
      { id: "image", label: "Image", artifactType: "Image", required: true },
      { id: "text", label: "Prompt", artifactType: "JsonData" }
    ],
    outputPorts: [{ id: "json", label: "Analysis", artifactType: "JsonData" }],
    paramSchema: modelPrompt,
    paramFields: [{ key: "prompt", label: "Prompt", input: "textarea" }],
    defaultParams: { prompt: "Describe composition and salient objects." }
  }),
  makeSpec("model.qwen_image_edit", {
    type: "model.qwen_image_edit",
    category: "Models",
    title: "Qwen Image Edit",
    icon: "WandSparkles",
    description: "Prompt-guided multi-reference image edit (Qwen Image Edit 2511).",
    inputPorts: [
      { id: "image", label: "Image", artifactType: "Image", required: true },
      { id: "image2", label: "Ref Image 2", artifactType: "Image" },
      { id: "image3", label: "Ref Image 3", artifactType: "Image" }
    ],
    outputPorts: [{ id: "image", label: "Edited", artifactType: "Image" }],
    paramSchema: qwenImageEditParams,
    paramFields: [
      { key: "prompt", label: "Edit Prompt", input: "textarea", placeholder: "Describe the edit to apply..." },
      { key: "negativePrompt", label: "Negative Prompt", input: "textarea", placeholder: "What to avoid..." },
      { key: "enableTurboMode", label: "Enable Turbo Mode", input: "boolean" },
      {
        key: "referenceLatentsMethod",
        label: "Reference Latents",
        input: "select",
        options: ["index_timestep_zero", "offset", "index", "uxo/uno"]
      },
      { key: "seed", label: "Seed (-1 random)", input: "number", min: -1, max: MAX_COMFY_SEED, step: 1 },
      { key: "steps", label: "Steps", input: "number", min: 1, max: 150, step: 1 },
      { key: "cfg", label: "CFG", input: "number", min: 0.1, max: 30, step: 0.1 },
      {
        key: "sampler",
        label: "Sampler",
        input: "select",
        options: [
          "euler",
          "euler_ancestral",
          "heun",
          "dpm_2",
          "dpm_2_ancestral",
          "lms",
          "dpm_fast",
          "dpm_adaptive",
          "dpmpp_2s_ancestral",
          "dpmpp_sde",
          "dpmpp_2m",
          "dpmpp_2m_sde",
          "ddim",
          "uni_pc",
          "uni_pc_bh2",
          "res_multistep"
        ]
      },
      {
        key: "scheduler",
        label: "Scheduler",
        input: "select",
        options: ["simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform", "beta"]
      },
      { key: "denoise", label: "Denoise", input: "number", min: 0, max: 1, step: 0.01 }
    ],
    defaultParams: {
      prompt: "Change the furniture leather difference in image 1 to the fur material in image 2.",
      negativePrompt: "",
      enableTurboMode: false,
      referenceLatentsMethod: "index_timestep_zero",
      seed: -1,
      steps: 40,
      cfg: 4,
      sampler: "euler",
      scheduler: "simple",
      denoise: 1
    },
    ui: {
      previewOutputIds: ["image"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("model.texturing", {
    type: "model.texturing",
    category: "Models",
    title: "Texturing",
    icon: "Paintbrush",
    description: "Generate texture set for mesh.",
    inputPorts: [
      { id: "mesh", label: "Mesh", artifactType: "Mesh", required: true },
      { id: "text", label: "Style", artifactType: "JsonData" }
    ],
    outputPorts: [{ id: "textures", label: "Texture Set", artifactType: "TextureSet" }],
    paramSchema: z.object({ style: z.string().max(4000).default("photoreal") }),
    paramFields: [{ key: "style", label: "Style", input: "text" }],
    defaultParams: { style: "photoreal" }
  }),
  makeSpec("geo.depth_estimation", {
    type: "geo.depth_estimation",
    category: "Geometry",
    title: "Depth Estimation",
    icon: "Mountain",
    description: "Estimate depth from an RGB image or MP4 video with Depth Anything 3.",
    inputPorts: [
      { id: "image", label: "Image", artifactType: "Image" },
      { id: "video", label: "Video", artifactType: "Video" }
    ],
    outputPorts: [
      { id: "depth", label: "Depth", artifactType: "DepthMap" },
      { id: "scene", label: "GLB Scene", artifactType: "SceneAsset" },
      { id: "depthVideo", label: "Depth Video", artifactType: "Video" },
      { id: "sequence", label: "Depth Sequence", artifactType: "JsonData", advancedOnly: true },
      { id: "camera", label: "Camera", artifactType: "Descriptor", advancedOnly: true },
      { id: "confidence", label: "Confidence", artifactType: "Image", hidden: true, advancedOnly: true },
      { id: "sky", label: "Sky", artifactType: "Image", hidden: true, advancedOnly: true },
      { id: "meta", label: "Meta", artifactType: "JsonData", hidden: true, advancedOnly: true }
    ],
    paramSchema: depthParams,
    paramFields: [
      { key: "modelVariant", label: "Model Variant", input: "select", options: ["da3-base", "da3metric-large"] },
      { key: "device", label: "Device", input: "select", options: ["auto", "cuda", "cpu"] },
      { key: "exportConfidence", label: "Export Confidence", input: "boolean" },
      { key: "exportSky", label: "Export Sky", input: "boolean" },
      { key: "saveNpz", label: "Save Raw NPZ", input: "boolean" },
      { key: "exportGlb", label: "Export GLB Scene", input: "boolean" },
      { key: "numMaxPoints", label: "GLB Max Points", input: "number", min: 1, max: 5000000, step: 10000 },
      { key: "confThreshPercentile", label: "GLB Confidence Percentile", input: "number", min: 0, max: 100, step: 1 },
      { key: "showCameras", label: "Bake Cameras Into GLB", input: "boolean" },
      { key: "useRayPose", label: "Use Ray Pose", input: "boolean" },
      { key: "refViewStrategy", label: "Ref View Strategy", input: "select", options: ["saddle_balanced", "first"] },
      { key: "frameStride", label: "Frame Stride", input: "number", min: 1, max: 120, step: 1 },
      { key: "maxFrames", label: "Max Frames", input: "number", min: 1, max: 2048, step: 1 },
      { key: "resizeLongEdge", label: "Resize Long Edge", input: "number", min: 0, max: 4096, step: 1 }
    ],
    defaultParams: {
      modelVariant: "da3-base",
      device: "auto",
      exportConfidence: true,
      exportSky: true,
      saveNpz: false,
      exportGlb: true,
      numMaxPoints: 1000000,
      confThreshPercentile: 40,
      showCameras: false,
      useRayPose: false,
      refViewStrategy: "saddle_balanced",
      frameStride: 1,
      maxFrames: 32,
      resizeLongEdge: 0
    },
    ui: {
      previewOutputIds: ["scene", "depthVideo", "depth"],
      hiddenOutputIds: ["confidence", "sky", "meta"],
      advancedOutputIds: ["sequence", "camera", "confidence", "sky", "meta"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("geo.pointcloud_from_depth", {
    type: "geo.pointcloud_from_depth",
    category: "Geometry",
    title: "Depth to Point Cloud",
    icon: "Sparkles",
    description: "Back-project depth map into point cloud.",
    inputPorts: [
      { id: "depth", label: "Depth", artifactType: "DepthMap", required: true },
      { id: "image", label: "Color", artifactType: "Image" },
      { id: "camera", label: "Camera", artifactType: "Descriptor" }
    ],
    outputPorts: [{ id: "pointcloud", label: "Point Cloud", artifactType: "PointCloud" }],
    paramSchema: pointcloudParams,
    paramFields: [
      { key: "density", label: "Density", input: "number" },
      { key: "depthScale", label: "Depth Scale", input: "number" }
    ],
    defaultParams: { density: 1, depthScale: 1 },
    ui: {
      previewOutputIds: ["pointcloud"],
      nodeRunEnabled: true
    }
  }),
  makeSpec("geo.mesh_reconstruction", {
    type: "geo.mesh_reconstruction",
    category: "Geometry",
    title: "Mesh Reconstruction",
    icon: "Cube",
    description: "Build watertight mesh from points.",
    inputPorts: [{ id: "pointcloud", label: "Point Cloud", artifactType: "PointCloud", required: true }],
    outputPorts: [{ id: "mesh", label: "Mesh", artifactType: "Mesh" }],
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
    inputPorts: [{ id: "mesh", label: "Mesh", artifactType: "Mesh", required: true }],
    outputPorts: [{ id: "mesh", label: "UV Mesh", artifactType: "Mesh" }],
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
      { id: "mesh", label: "Mesh", artifactType: "Mesh", required: true },
      { id: "textures", label: "Textures", artifactType: "TextureSet" }
    ],
    outputPorts: [{ id: "textures", label: "Baked Textures", artifactType: "TextureSet" }],
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
      { id: "mesh", label: "Mesh", artifactType: "Mesh" },
      { id: "pointcloud", label: "Point Cloud", artifactType: "PointCloud" },
      { id: "textures", label: "Textures", artifactType: "TextureSet" }
    ],
    outputPorts: [{ id: "scene", label: "Scene", artifactType: "SceneAsset" }],
    paramSchema: exportParams,
    paramFields: [{ key: "format", label: "Format", input: "select", options: ["mesh_glb", "point_ply", "splat_ksplat"] }],
    defaultParams: { format: "mesh_glb" }
  }),
  makeSpec("out.open_in_viewer", {
    type: "out.open_in_viewer",
    category: "Outputs",
    title: "Preview",
    icon: "ExternalLink",
    description: "Connect any node output to preview its latest artifact.",
    inputPorts: [
      { id: "artifact", label: "Artifact", artifactType: "AnyArtifact", required: true },
      { id: "environment", label: "Environment", artifactType: "JsonData" }
    ],
    outputPorts: [],
    paramSchema: previewNodeParams,
    paramFields: [],
    defaultParams: {
      previewMode: "auto",
      sequenceFps: 12,
      sequenceLoop: true,
      sequenceAutoplay: false,
      previewFit: "contain"
    }
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

export function mergeNodeParamsWithDefaults(nodeType: WorkflowNodeType, rawParams: unknown) {
  const spec = nodeSpecRegistry[nodeType];
  const paramsRecord = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
    ? (rawParams as Record<string, unknown>)
    : {};

  const mergedCandidate = {
    ...spec.defaultParams,
    ...paramsRecord
  } as Record<string, unknown>;
  const parsed = spec.paramSchema.safeParse(mergedCandidate);
  if (!parsed.success) {
    throw new Error(`Invalid parameters for ${nodeType}: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  }
  const selectedArtifactParams = Object.fromEntries(
    Object.entries(paramsRecord).filter(
      ([key, value]) => key.startsWith("__selectedArtifact__") && typeof value === "string" && value.length <= 180
    )
  );
  const merged = {
    ...(parsed.data as Record<string, unknown>),
    ...selectedArtifactParams
  };

  if (nodeType === "model.sam3d_objects") {
    const normalizedScene = mergeSceneGenerationParams(merged);
    if (normalizedScene.configPreset !== "Custom") {
      return applySceneGenerationPreset(normalizedScene, normalizedScene.configPreset);
    }
    return normalizedScene;
  }

  if (nodeType === "input.image") {
    const normalizedModel = merged.generatorModel === "Qwen-Image-Edit" ? "Qwen-Distill" : merged.generatorModel;
    const normalized = {
      ...merged,
      generatorModel: normalizedModel
    } as Record<string, unknown>;

    const isLegacyZImageDefaults =
      normalizedModel === "Z-Image-Turbo" &&
      Number(normalized.steps) === 20 &&
      Number(normalized.cfg) === 8 &&
      String(normalized.sampler ?? "") === "euler" &&
      String(normalized.scheduler ?? "") === "normal";

    if (isLegacyZImageDefaults) {
      return {
        ...normalized,
        seed: -1,
        steps: 4,
        cfg: 1,
        width: 1024,
        height: 1024,
        sampler: "res_multistep",
        scheduler: "simple",
        negativePrompt: "",
        checkpoint: ""
      };
    }

    return normalized;
  }

  return merged;
}
