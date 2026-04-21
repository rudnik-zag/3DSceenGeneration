import { promises as fs } from "fs";
import path from "path";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";
import { ComfyClient } from "@/lib/comfy/client";
import { withComfyRuntime } from "@/lib/comfy/runtime";
import { ONE_PIXEL_PNG } from "@/lib/execution/mock-assets";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const DEFAULT_ZIMAGE_WORKFLOW: Record<string, JsonValue> = {
  "3": {
    class_type: "KSampler",
    inputs: {
      model: ["11", 0],
      positive: ["27", 0],
      negative: ["33", 0],
      latent_image: ["13", 0],
      seed: "__SEED__",
      steps: "__STEPS__",
      cfg: "__CFG__",
      sampler_name: "__SAMPLER__",
      scheduler: "__SCHEDULER__",
      denoise: "__DENOISE__"
    }
  },
  "8": {
    class_type: "VAEDecode",
    inputs: {
      samples: ["3", 0],
      vae: ["29", 0]
    }
  },
  "11": {
    class_type: "ModelSamplingAuraFlow",
    inputs: {
      model: ["28", 0],
      shift: "__AURAFLOW_SHIFT__"
    }
  },
  "13": {
    class_type: "EmptySD3LatentImage",
    inputs: {
      width: "__WIDTH__",
      height: "__HEIGHT__",
      batch_size: 1,
    }
  },
  "27": {
    class_type: "CLIPTextEncode",
    inputs: {
      clip: ["30", 0],
      text: "__PROMPT__"
    }
  },
  "28": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "__UNET__",
      weight_dtype: "__UNET_WEIGHT_DTYPE__"
    }
  },
  "29": {
    class_type: "VAELoader",
    inputs: {
      vae_name: "__VAE__"
    }
  },
  "30": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "__CLIP__",
      type: "__CLIP_TYPE__",
      device: "__CLIP_DEVICE__"
    }
  },
  "33": {
    class_type: "ConditioningZeroOut",
    inputs: {
      conditioning: ["27", 0]
    }
  },
  "60": {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: "__FILENAME_PREFIX__",
      images: ["8", 0]
    }
  }
};

const DEFAULT_QWEN_DISTILL_WORKFLOW: Record<string, JsonValue> = {
  "3": {
    class_type: "KSampler",
    inputs: {
      model: ["66", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["72", 0],
      seed: "__SEED__",
      steps: "__STEPS__",
      cfg: "__CFG__",
      sampler_name: "__SAMPLER__",
      scheduler: "__SCHEDULER__",
      denoise: "__DENOISE__"
    }
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: {
      clip: ["38", 0],
      text: "__PROMPT__"
    }
  },
  "7": {
    class_type: "CLIPTextEncode",
    inputs: {
      clip: ["38", 0],
      text: "__NEGATIVE_PROMPT__"
    }
  },
  "8": {
    class_type: "VAEDecode",
    inputs: {
      samples: ["3", 0],
      vae: ["39", 0]
    }
  },
  "37": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "__UNET__",
      weight_dtype: "__UNET_WEIGHT_DTYPE__"
    }
  },
  "38": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "__CLIP__",
      type: "__CLIP_TYPE__",
      device: "__CLIP_DEVICE__"
    }
  },
  "39": {
    class_type: "VAELoader",
    inputs: {
      vae_name: "__VAE__"
    }
  },
  "60": {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: "__FILENAME_PREFIX__",
      images: ["8", 0]
    }
  },
  "66": {
    class_type: "ModelSamplingAuraFlow",
    inputs: {
      model: ["37", 0],
      shift: "__AURAFLOW_SHIFT__"
    }
  },
  "72": {
    class_type: "EmptySD3LatentImage",
    inputs: {
      width: "__WIDTH__",
      height: "__HEIGHT__",
      batch_size: 1
    }
  }
};

const DEFAULT_QWEN_EDIT_2511_WORKFLOW: Record<string, JsonValue> = {
  "60": {
    class_type: "SaveImage",
    inputs: {
      filename_prefix: "__FILENAME_PREFIX__",
      images: ["158", 0]
    }
  },
  "78": {
    class_type: "LoadImage",
    inputs: {
      image: "__INPUT_IMAGE__",
      upload: "image"
    }
  },
  "79": {
    class_type: "LoadImage",
    inputs: {
      image: "__INPUT_IMAGE2__",
      upload: "image"
    }
  },
  "80": {
    class_type: "LoadImage",
    inputs: {
      image: "__INPUT_IMAGE3__",
      upload: "image"
    }
  },
  "145": {
    class_type: "ModelSamplingAuraFlow",
    inputs: {
      model: ["161", 0],
      shift: "__AURAFLOW_SHIFT__"
    }
  },
  "146": {
    class_type: "VAELoader",
    inputs: {
      vae_name: "__VAE__"
    }
  },
  "147": {
    class_type: "FluxKontextMultiReferenceLatentMethod",
    inputs: {
      conditioning: ["149", 0],
      reference_latents_method: "__REFERENCE_LATENTS_METHOD__"
    }
  },
  "148": {
    class_type: "FluxKontextMultiReferenceLatentMethod",
    inputs: {
      conditioning: ["151", 0],
      reference_latents_method: "__REFERENCE_LATENTS_METHOD__"
    }
  },
  "149": {
    class_type: "TextEncodeQwenImageEditPlus",
    inputs: {
      clip: ["162", 0],
      vae: ["146", 0],
      image1: ["160", 0],
      image2: ["79", 0],
      image3: ["80", 0],
      prompt: "__NEGATIVE_PROMPT__"
    }
  },
  "151": {
    class_type: "TextEncodeQwenImageEditPlus",
    inputs: {
      clip: ["162", 0],
      vae: ["146", 0],
      image1: ["160", 0],
      image2: ["79", 0],
      image3: ["80", 0],
      prompt: "__PROMPT__"
    }
  },
  "152": {
    class_type: "CFGNorm",
    inputs: {
      model: ["145", 0],
      strength: 1
    }
  },
  "153": {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      model: ["152", 0],
      lora_name: "__LORA__",
      strength_model: "__LORA_STRENGTH__"
    }
  },
  "154": {
    class_type: "PrimitiveFloat",
    inputs: {
      value: "__BASE_CFG__"
    }
  },
  "155": {
    class_type: "PrimitiveFloat",
    inputs: {
      value: "__TURBO_CFG__"
    }
  },
  "156": {
    class_type: "VAEEncode",
    inputs: {
      pixels: ["160", 0],
      vae: ["146", 0]
    }
  },
  "158": {
    class_type: "VAEDecode",
    inputs: {
      samples: ["169", 0],
      vae: ["146", 0]
    }
  },
  "160": {
    class_type: "FluxKontextImageScale",
    inputs: {
      image: ["78", 0]
    }
  },
  "161": {
    class_type: "UNETLoader",
    inputs: {
      unet_name: "__UNET__",
      weight_dtype: "__UNET_WEIGHT_DTYPE__"
    }
  },
  "162": {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "__CLIP__",
      type: "__CLIP_TYPE__",
      device: "__CLIP_DEVICE__"
    }
  },
  "163": {
    class_type: "ComfySwitchNode",
    inputs: {
      switch: ["168", 0],
      on_false: ["152", 0],
      on_true: ["153", 0]
    }
  },
  "164": {
    class_type: "ComfySwitchNode",
    inputs: {
      switch: ["168", 0],
      on_false: ["154", 0],
      on_true: ["155", 0]
    }
  },
  "165": {
    class_type: "PrimitiveInt",
    inputs: {
      value: "__TURBO_STEPS__"
    }
  },
  "166": {
    class_type: "PrimitiveInt",
    inputs: {
      value: "__BASE_STEPS__"
    }
  },
  "167": {
    class_type: "ComfySwitchNode",
    inputs: {
      switch: ["168", 0],
      on_false: ["166", 0],
      on_true: ["165", 0]
    }
  },
  "168": {
    class_type: "PrimitiveBoolean",
    inputs: {
      value: "__ENABLE_TURBO_MODE__"
    }
  },
  "169": {
    class_type: "KSampler",
    inputs: {
      model: ["163", 0],
      positive: ["148", 0],
      negative: ["147", 0],
      latent_image: ["156", 0],
      seed: "__SEED__",
      steps: ["167", 0],
      cfg: ["164", 0],
      sampler_name: "__SAMPLER__",
      scheduler: "__SCHEDULER__",
      denoise: "__DENOISE__"
    }
  }
};

function isTruthy(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveComfyEnabled() {
  return isTruthy(process.env.COMFYUI_ENABLED);
}

function resolveMockFallbackAllowed() {
  const raw = process.env.COMFYUI_ALLOW_MOCK_FALLBACK;
  if (raw === undefined) return true;
  return isTruthy(raw);
}

function resolveComfyClient() {
  const baseUrl = process.env.COMFYUI_BASE_URL?.trim() || "http://127.0.0.1:8188";
  const timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS ?? 180_000);
  const authToken = process.env.COMFYUI_AUTH_TOKEN?.trim() || null;
  return new ComfyClient({
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 180_000,
    authToken
  });
}

function coercePromptFromTextArtifact(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.value === "string" && parsed.value.trim().length > 0) return parsed.value.trim();
    if (typeof parsed.prompt === "string" && parsed.prompt.trim().length > 0) return parsed.prompt.trim();
  } catch {
    // Ignore malformed text artifact payload.
  }
  return "";
}

async function resolvePrompt(ctx: NodeExecutionContext) {
  const paramPrompt = typeof ctx.params.prompt === "string" ? ctx.params.prompt.trim() : "";
  if (paramPrompt.length > 0) return paramPrompt;
  const textInput = ctx.inputs.text?.[0] ?? null;
  if (!textInput) return "";
  try {
    const buffer = await ctx.loadInputBuffer(textInput);
    const fromArtifact = coercePromptFromTextArtifact(buffer.toString("utf8"));
    if (fromArtifact.length > 0) return fromArtifact;
  } catch {
    // Ignore unreadable text artifact.
  }
  return "";
}

async function loadWorkflowTemplate(templatePath: string | null) {
  if (!templatePath || templatePath.length === 0) return null;
  const absolutePath = path.isAbsolute(templatePath) ? templatePath : path.resolve(process.cwd(), templatePath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Comfy workflow template must be a JSON object: ${absolutePath}`);
  }
  const maybeObject = parsed as Record<string, unknown>;
  if (Array.isArray(maybeObject.nodes)) {
    throw new Error(
      `Comfy workflow template at ${absolutePath} looks like UI JSON. Export API format from ComfyUI (Workflow -> Export API).`
    );
  }
  return parsed as Record<string, JsonValue>;
}

function injectTemplatePlaceholders(value: JsonValue, placeholders: Record<string, JsonValue>): JsonValue {
  if (typeof value === "string") {
    if (Object.prototype.hasOwnProperty.call(placeholders, value)) {
      return placeholders[value];
    }
    let next = value;
    for (const [key, replacement] of Object.entries(placeholders)) {
      if (!next.includes(key)) continue;
      if (typeof replacement === "string" || typeof replacement === "number" || typeof replacement === "boolean") {
        next = next.split(key).join(String(replacement));
      }
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => injectTemplatePlaceholders(entry as JsonValue, placeholders));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    const next: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = injectTemplatePlaceholders(entry, placeholders);
    }
    return next;
  }
  return value;
}

function extensionFromContentType(contentType: string) {
  const lowered = contentType.toLowerCase();
  if (lowered.includes("image/png")) return "png";
  if (lowered.includes("image/webp")) return "webp";
  if (lowered.includes("image/svg")) return "svg";
  if (lowered.includes("image/jpeg") || lowered.includes("image/jpg")) return "jpg";
  return "png";
}

function chooseSeed(ctx: NodeExecutionContext) {
  const candidate = Number(ctx.params.seed);
  if (Number.isFinite(candidate) && candidate >= 0) return Math.floor(candidate);
  return Math.floor(Math.random() * 2_147_483_647);
}

function coerceInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function coerceBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  }
  return fallback;
}

function coerceFloat(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function snapToStep(value: number, step: number, min: number, max: number) {
  const snapped = Math.round(value / step) * step;
  if (snapped < min) return min;
  if (snapped > max) return max;
  return snapped;
}

const ZIMAGE_ALLOWED_SAMPLERS = new Set([
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
]);

const ZIMAGE_ALLOWED_SCHEDULERS = new Set([
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta"
]);

function normalizeZImageSampler(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "euler";
  return ZIMAGE_ALLOWED_SAMPLERS.has(raw) ? raw : "euler";
}

function normalizeZImageScheduler(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "normal";
  return ZIMAGE_ALLOWED_SCHEDULERS.has(raw) ? raw : "normal";
}

function normalizeZImageDimension(value: unknown, fallback: number) {
  const parsed = coerceInt(value, fallback, 256, 2048);
  return snapToStep(parsed, 64, 256, 2048);
}

function normalizeQwenDistillDimension(value: unknown, fallback: number) {
  const parsed = coerceInt(value, fallback, 256, 2048);
  return snapToStep(parsed, 16, 256, 2048);
}

function asJsonObject(value: JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Comfy workflow payload must be a JSON object after placeholder injection.");
  }
  return value as Record<string, unknown>;
}

function extractImageInput(ctx: NodeExecutionContext, inputId = "image") {
  return ctx.inputs[inputId]?.[0] ?? null;
}

function resultWithWarning(result: NodeExecutionResult, warning: string): NodeExecutionResult {
  const nextWarnings = [...(result.warnings ?? [])];
  if (!nextWarnings.includes(warning)) nextWarnings.push(warning);
  return {
    ...result,
    warnings: nextWarnings
  };
}

function buildMockGeneratedSvg(ctx: NodeExecutionContext, model: string, prompt: string): NodeExecutionResult {
  const text = prompt.length > 0 ? prompt : "Generated image";
  const safe = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    `<text x="64" y="140" fill="#e2e8f0" font-size="36" font-family="Arial, sans-serif">Mock ${model}</text>`,
    `<foreignObject x="64" y="180" width="896" height="780"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#e2e8f0;font-size:24px;font-family:Arial,sans-serif;line-height:1.4;">${safe}</div></foreignObject>`,
    `</svg>`
  ].join("");
  return {
    warnings: [
      "ComfyUI execution unavailable. Returned mock generated image."
    ],
    outputs: [
      {
        outputId: "image",
        kind: "image",
        mimeType: "image/svg+xml",
        extension: "svg",
        buffer: Buffer.from(svg, "utf8"),
        preview: {
          extension: "svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.from(svg, "utf8")
        },
        meta: {
          outputKey: "image",
          source: "mock-generate",
          model,
          prompt,
          fallbackReason: "comfy_unavailable",
          nodeType: ctx.nodeType
        },
        hidden: false
      }
    ]
  };
}

function buildMockEditImage(ctx: NodeExecutionContext, prompt: string): NodeExecutionResult {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">`,
    `<rect width="100%" height="100%" fill="#0b1220"/>`,
    `<text x="56" y="120" fill="#93c5fd" font-size="34" font-family="Arial, sans-serif">Mock Qwen Image Edit</text>`,
    `<text x="56" y="180" fill="#e2e8f0" font-size="24" font-family="Arial, sans-serif">${prompt.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`,
    `</svg>`
  ].join("");
  const buffer = Buffer.from(svg, "utf8");
  return {
    warnings: [
      "ComfyUI execution unavailable. Returned mock edited image."
    ],
    outputs: [
      {
        outputId: "image",
        kind: "image",
        mimeType: "image/svg+xml",
        extension: "svg",
        buffer,
        preview: {
          extension: "svg",
          mimeType: "image/svg+xml",
          buffer
        },
        meta: {
          outputKey: "image",
          source: "mock-qwen-edit",
          prompt,
          fallbackReason: "comfy_unavailable",
          nodeType: ctx.nodeType
        },
        hidden: false
      }
    ]
  };
}

async function executeComfyWorkflowAndExtractImage(params: {
  ctx: NodeExecutionContext;
  workflow: Record<string, JsonValue>;
  placeholders: Record<string, JsonValue>;
  preferredOutputNodeId?: string | null;
  extraData?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<NodeExecutionResult> {
  const comfy = resolveComfyClient();
  const workflowWithValues = injectTemplatePlaceholders(params.workflow as JsonValue, params.placeholders);
  const payload = asJsonObject(workflowWithValues);
  const queued = await comfy.queuePrompt(payload, params.extraData);
  const history = await comfy.waitForPromptCompletion({
    promptId: queued.promptId,
    maxWaitMs: params.timeoutMs
  });
  const imageRef = ComfyClient.pickFirstImageFromHistory(history, params.preferredOutputNodeId ?? null);
  if (!imageRef) {
    throw new Error(`Comfy prompt completed without image outputs (prompt_id=${queued.promptId}).`);
  }
  const downloaded = await comfy.downloadImage(imageRef);
  const extension = extensionFromContentType(downloaded.contentType);
  return {
    mode: "comfy",
    outputs: [
      {
        outputId: "image",
        kind: "image",
        mimeType: downloaded.contentType,
        extension,
        buffer: downloaded.buffer,
        preview: {
          extension,
          mimeType: downloaded.contentType,
          buffer: downloaded.buffer
        },
        meta: {
          outputKey: "image",
          provider: "comfyui",
          comfyPromptId: queued.promptId,
          comfyOutputRef: imageRef
        },
        hidden: false
      }
    ]
  };
}

export async function executeComfyZImageNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const prompt = await resolvePrompt(ctx);
  const negativePromptParam = typeof ctx.params.negativePrompt === "string" ? ctx.params.negativePrompt.trim() : "";
  const negativePrompt = negativePromptParam || process.env.COMFYUI_ZIMAGE_NEGATIVE_PROMPT?.trim() || "";
  const checkpointParam = typeof ctx.params.checkpoint === "string" ? ctx.params.checkpoint.trim() : "";
  const unet =
    process.env.COMFYUI_ZIMAGE_UNET?.trim() ||
    checkpointParam ||
    process.env.COMFYUI_ZIMAGE_CHECKPOINT?.trim() ||
    "z_image_turbo_bf16.safetensors";
  const vae = process.env.COMFYUI_ZIMAGE_VAE?.trim() || "ae.safetensors";
  const clip = process.env.COMFYUI_ZIMAGE_CLIP?.trim() || "qwen_3_4b.safetensors";
  const clipType = process.env.COMFYUI_ZIMAGE_CLIP_TYPE?.trim() || "lumina2";
  const clipDevice = process.env.COMFYUI_ZIMAGE_CLIP_DEVICE?.trim() || "default";
  const unetWeightDType = process.env.COMFYUI_ZIMAGE_UNET_WEIGHT_DTYPE?.trim() || "default";
  const seed = chooseSeed(ctx);
  const steps = coerceInt(ctx.params.steps, coerceInt(process.env.COMFYUI_ZIMAGE_STEPS, 4, 1, 150), 1, 150);
  const cfg = coerceFloat(ctx.params.cfg, coerceFloat(process.env.COMFYUI_ZIMAGE_CFG, 1, 0.1, 30), 0.1, 30);
  const width = normalizeZImageDimension(ctx.params.width, 1024);
  const height = normalizeZImageDimension(ctx.params.height, 1024);
  const sampler = normalizeZImageSampler(
    typeof ctx.params.sampler === "string" && ctx.params.sampler.trim().length > 0
      ? ctx.params.sampler
      : process.env.COMFYUI_ZIMAGE_SAMPLER
  );
  const scheduler = normalizeZImageScheduler(
    typeof ctx.params.scheduler === "string" && ctx.params.scheduler.trim().length > 0
      ? ctx.params.scheduler
      : process.env.COMFYUI_ZIMAGE_SCHEDULER
  );
  const denoise = coerceFloat(ctx.params.denoise, coerceFloat(process.env.COMFYUI_ZIMAGE_DENOISE, 1, 0, 1), 0, 1);
  const auraFlowShift = coerceFloat(process.env.COMFYUI_ZIMAGE_AURAFLOW_SHIFT, 3, 0, 12);
  const workflowPath = process.env.COMFYUI_ZIMAGE_WORKFLOW_PATH?.trim() || null;
  const loaded = await loadWorkflowTemplate(workflowPath);
  const workflow = loaded ?? DEFAULT_ZIMAGE_WORKFLOW;
  const preferredOutputNodeId = process.env.COMFYUI_ZIMAGE_OUTPUT_NODE_ID?.trim() || "60";
  const workflowTemplateSource = loaded ? (workflowPath as string) : "builtin:z-image-turbo";

  const placeholders: Record<string, JsonValue> = {
    __PROMPT__: prompt.length > 0 ? prompt : "cinematic detailed 3d environment concept art",
    __NEGATIVE_PROMPT__: negativePrompt,
    __SEED__: seed,
    __STEPS__: steps,
    __CFG__: cfg,
    __WIDTH__: width,
    __HEIGHT__: height,
    __SAMPLER__: sampler,
    __SCHEDULER__: scheduler,
    __DENOISE__: denoise,
    __AURAFLOW_SHIFT__: auraFlowShift,
    __UNET__: unet,
    __VAE__: vae,
    __CLIP__: clip,
    __CLIP_TYPE__: clipType,
    __CLIP_DEVICE__: clipDevice,
    __UNET_WEIGHT_DTYPE__: unetWeightDType,
    __CHECKPOINT__: unet,
    __FILENAME_PREFIX__: `tribalai_${ctx.runId}_${ctx.nodeId}`
  };

  if (!resolveComfyEnabled()) {
    return resultWithWarning(buildMockGeneratedSvg(ctx, "Z-Image-Turbo", placeholders.__PROMPT__ as string), "COMFYUI_ENABLED=false");
  }

  try {
    const result = await withComfyRuntime(async () =>
      executeComfyWorkflowAndExtractImage({
        ctx,
        workflow,
        placeholders,
        preferredOutputNodeId,
        extraData: {
          tribalai_run_id: ctx.runId,
          tribalai_node_id: ctx.nodeId,
          tribalai_node_type: ctx.nodeType
        },
        timeoutMs: Number(process.env.COMFYUI_ZIMAGE_TIMEOUT_MS ?? process.env.COMFYUI_TIMEOUT_MS ?? 300_000)
      })
    );
    const output = result.outputs[0];
    output.meta = {
      ...(output.meta ?? {}),
      model: "z-image-turbo",
      mode: "generate",
      prompt: placeholders.__PROMPT__,
      negativePrompt,
      seed,
      steps,
      cfg,
      width,
      height,
      sampler,
      scheduler,
      denoise,
      auraFlowShift,
      unet,
      vae,
      clip,
      clipType,
      clipDevice,
      unetWeightDType,
      checkpoint: unet,
      workflowTemplateSource
    };
    return result;
  } catch (error) {
    if (!resolveMockFallbackAllowed()) throw error;
    const result = buildMockGeneratedSvg(ctx, "Z-Image-Turbo", placeholders.__PROMPT__ as string);
    return resultWithWarning(result, `Comfy Z-Image failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function executeComfyQwenImageEditNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const sourceImage = extractImageInput(ctx, "image");
  if (!sourceImage) {
    throw new Error("Qwen Image Edit requires image input.");
  }
  const sourceImage2 = extractImageInput(ctx, "image2") ?? sourceImage;
  const sourceImage3 = extractImageInput(ctx, "image3") ?? sourceImage2;
  const prompt = await resolvePrompt(ctx);
  const negativePromptParam = typeof ctx.params.negativePrompt === "string" ? ctx.params.negativePrompt.trim() : "";
  const negativePrompt = negativePromptParam || process.env.COMFYUI_QWEN_EDIT_NEGATIVE_PROMPT?.trim() || "";

  const envTurboMode = isTruthy(process.env.COMFYUI_QWEN_EDIT_ENABLE_TURBO_MODE);
  const turboMode = coerceBoolean(ctx.params.enableTurboMode, envTurboMode);
  const envBaseSteps = coerceInt(process.env.COMFYUI_QWEN_EDIT_STEPS, 40, 1, 150);
  const envTurboSteps = coerceInt(process.env.COMFYUI_QWEN_EDIT_TURBO_STEPS, 4, 1, 150);
  const envBaseCfg = coerceFloat(process.env.COMFYUI_QWEN_EDIT_CFG, 4, 0.1, 30);
  const envTurboCfg = coerceFloat(process.env.COMFYUI_QWEN_EDIT_TURBO_CFG, 1, 0.1, 30);
  const steps = coerceInt(ctx.params.steps, turboMode ? envTurboSteps : envBaseSteps, 1, 150);
  const cfg = coerceFloat(ctx.params.cfg, turboMode ? envTurboCfg : envBaseCfg, 0.1, 30);
  const baseSteps = turboMode ? envBaseSteps : steps;
  const turboSteps = turboMode ? steps : envTurboSteps;
  const baseCfg = turboMode ? envBaseCfg : cfg;
  const turboCfg = turboMode ? cfg : envTurboCfg;
  const sampler = normalizeZImageSampler(
    typeof ctx.params.sampler === "string" && ctx.params.sampler.trim().length > 0
      ? ctx.params.sampler
      : process.env.COMFYUI_QWEN_EDIT_SAMPLER
  );
  const scheduler = normalizeZImageScheduler(
    typeof ctx.params.scheduler === "string" && ctx.params.scheduler.trim().length > 0
      ? ctx.params.scheduler
      : process.env.COMFYUI_QWEN_EDIT_SCHEDULER
  );
  const denoise = coerceFloat(
    ctx.params.denoise,
    coerceFloat(process.env.COMFYUI_QWEN_EDIT_DENOISE, 1, 0, 1),
    0,
    1
  );
  const seed = chooseSeed(ctx);
  const auraFlowShift = coerceFloat(process.env.COMFYUI_QWEN_EDIT_AURAFLOW_SHIFT, 3.1, 0, 12);
  const referenceLatentsMethod =
    (typeof ctx.params.referenceLatentsMethod === "string" && ctx.params.referenceLatentsMethod.trim()) ||
    process.env.COMFYUI_QWEN_EDIT_REFERENCE_LATENTS_METHOD?.trim() ||
    "index_timestep_zero";
  const unet = process.env.COMFYUI_QWEN_EDIT_UNET?.trim() || "qwen_image_edit_2511_bf16.safetensors";
  const vae = process.env.COMFYUI_QWEN_EDIT_VAE?.trim() || "qwen_image_vae.safetensors";
  const clip = process.env.COMFYUI_QWEN_EDIT_CLIP?.trim() || "qwen_2.5_vl_7b_fp8_scaled.safetensors";
  const clipType = process.env.COMFYUI_QWEN_EDIT_CLIP_TYPE?.trim() || "qwen_image";
  const clipDevice = process.env.COMFYUI_QWEN_EDIT_CLIP_DEVICE?.trim() || "default";
  const unetWeightDType = process.env.COMFYUI_QWEN_EDIT_UNET_WEIGHT_DTYPE?.trim() || "default";
  const lora = process.env.COMFYUI_QWEN_EDIT_LORA?.trim() || "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors";
  const loraStrength = coerceFloat(process.env.COMFYUI_QWEN_EDIT_LORA_STRENGTH, 1, 0, 4);
  const preferredOutputNodeId = process.env.COMFYUI_QWEN_EDIT_OUTPUT_NODE_ID?.trim() || "60";
  const timeoutMs = Number(process.env.COMFYUI_QWEN_EDIT_TIMEOUT_MS ?? process.env.COMFYUI_TIMEOUT_MS ?? 360_000);

  const qwenWorkflowPath = process.env.COMFYUI_QWEN_EDIT_WORKFLOW_PATH?.trim() || null;
  const loaded = await loadWorkflowTemplate(qwenWorkflowPath);
  const workflow = loaded ?? DEFAULT_QWEN_EDIT_2511_WORKFLOW;
  const workflowTemplateSource = loaded ? (qwenWorkflowPath as string) : "builtin:qwen-image-edit:2511";

  if (!resolveComfyEnabled()) {
    return resultWithWarning(buildMockEditImage(ctx, prompt), "COMFYUI_ENABLED=false");
  }

  const [inputBuffer, inputBuffer2, inputBuffer3] = await Promise.all([
    ctx.loadInputBuffer(sourceImage),
    ctx.loadInputBuffer(sourceImage2),
    ctx.loadInputBuffer(sourceImage3)
  ]);

  const resolveImageExt = (mimeType: string) => {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("webp")) return "webp";
    return "jpg";
  };

  try {
    const result = await withComfyRuntime(async () => {
      const comfy = resolveComfyClient();
      const uploaded = await comfy.uploadImage({
        buffer: inputBuffer,
        filename: `tribalai_${ctx.runId}_${ctx.nodeId}_input1.${resolveImageExt(sourceImage.mimeType)}`,
        type: "input",
        overwrite: true
      });
      const uploaded2 = await comfy.uploadImage({
        buffer: inputBuffer2,
        filename: `tribalai_${ctx.runId}_${ctx.nodeId}_input2.${resolveImageExt(sourceImage2.mimeType)}`,
        type: "input",
        overwrite: true
      });
      const uploaded3 = await comfy.uploadImage({
        buffer: inputBuffer3,
        filename: `tribalai_${ctx.runId}_${ctx.nodeId}_input3.${resolveImageExt(sourceImage3.mimeType)}`,
        type: "input",
        overwrite: true
      });

      const placeholders: Record<string, JsonValue> = {
        __PROMPT__: prompt.length > 0 ? prompt : "enhance details and preserve structure",
        __NEGATIVE_PROMPT__: negativePrompt,
        __INPUT_IMAGE__: uploaded.filename,
        __INPUT_IMAGE2__: uploaded2.filename,
        __INPUT_IMAGE3__: uploaded3.filename,
        __FILENAME_PREFIX__: `tribalai_qwen_edit_${ctx.runId}_${ctx.nodeId}`,
        __ENABLE_TURBO_MODE__: turboMode,
        __BASE_STEPS__: baseSteps,
        __TURBO_STEPS__: turboSteps,
        __BASE_CFG__: baseCfg,
        __TURBO_CFG__: turboCfg,
        __SEED__: seed,
        __STEPS__: steps,
        __CFG__: cfg,
        __SAMPLER__: sampler,
        __SCHEDULER__: scheduler,
        __DENOISE__: denoise,
        __AURAFLOW_SHIFT__: auraFlowShift,
        __REFERENCE_LATENTS_METHOD__: referenceLatentsMethod,
        __UNET__: unet,
        __VAE__: vae,
        __CLIP__: clip,
        __CLIP_TYPE__: clipType,
        __CLIP_DEVICE__: clipDevice,
        __UNET_WEIGHT_DTYPE__: unetWeightDType,
        __LORA__: lora,
        __LORA_STRENGTH__: loraStrength
      };
      const executed = await executeComfyWorkflowAndExtractImage({
        ctx,
        workflow,
        placeholders,
        preferredOutputNodeId,
        extraData: {
          tribalai_run_id: ctx.runId,
          tribalai_node_id: ctx.nodeId,
          tribalai_node_type: ctx.nodeType
        },
        timeoutMs
      });
      return { executed, uploaded, uploaded2, uploaded3, placeholders };
    });
    const output = result.executed.outputs[0];
    output.meta = {
      ...(output.meta ?? {}),
      model: "qwen-image-edit",
      mode: "edit",
      prompt: result.placeholders.__PROMPT__,
      negativePrompt,
      seed,
      steps,
      cfg,
      sampler,
      scheduler,
      denoise,
      auraFlowShift,
      turboMode,
      baseSteps,
      turboSteps,
      baseCfg,
      turboCfg,
      referenceLatentsMethod,
      unet,
      vae,
      clip,
      lora,
      loraStrength,
      workflowTemplateSource,
      sourceImageArtifactId: sourceImage.artifactId,
      sourceImageHash: sourceImage.hash,
      sourceImageStorageKey: sourceImage.storageKey,
      sourceImage2ArtifactId: sourceImage2.artifactId,
      sourceImage2StorageKey: sourceImage2.storageKey,
      sourceImage3ArtifactId: sourceImage3.artifactId,
      sourceImage3StorageKey: sourceImage3.storageKey,
      comfyInputImage: result.uploaded,
      comfyInputImage2: result.uploaded2,
      comfyInputImage3: result.uploaded3
    };
    return result.executed;
  } catch (error) {
    if (!resolveMockFallbackAllowed()) throw error;
    const fallback = buildMockEditImage(ctx, prompt);
    return resultWithWarning(fallback, `Comfy Qwen edit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function executeComfyQwenImageGenerateNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const prompt = await resolvePrompt(ctx);
  const negativePromptParam = typeof ctx.params.negativePrompt === "string" ? ctx.params.negativePrompt.trim() : "";
  const negativePrompt =
    negativePromptParam ||
    process.env.COMFYUI_QWEN_GENERATE_NEGATIVE_PROMPT?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_NEGATIVE_PROMPT?.trim() ||
    "";
  const envTurboMode =
    isTruthy(process.env.COMFYUI_QWEN_GENERATE_ENABLE_TURBO_MODE) ||
    isTruthy(process.env.COMFYUI_QWEN_EDIT_ENABLE_TURBO_MODE);
  const turboMode = coerceBoolean(ctx.params.enableTurboMode, envTurboMode);
  const envBaseSteps = coerceInt(
    process.env.COMFYUI_QWEN_GENERATE_STEPS ?? process.env.COMFYUI_QWEN_EDIT_STEPS,
    40,
    1,
    150
  );
  const envTurboSteps = coerceInt(
    process.env.COMFYUI_QWEN_GENERATE_TURBO_STEPS ?? process.env.COMFYUI_QWEN_EDIT_TURBO_STEPS,
    4,
    1,
    150
  );
  const envBaseCfg = coerceFloat(
    process.env.COMFYUI_QWEN_GENERATE_CFG ?? process.env.COMFYUI_QWEN_EDIT_CFG,
    4,
    0.1,
    30
  );
  const envTurboCfg = coerceFloat(
    process.env.COMFYUI_QWEN_GENERATE_TURBO_CFG ?? process.env.COMFYUI_QWEN_EDIT_TURBO_CFG,
    1,
    0.1,
    30
  );
  const steps = coerceInt(ctx.params.steps, turboMode ? envTurboSteps : envBaseSteps, 1, 150);
  const cfg = coerceFloat(ctx.params.cfg, turboMode ? envTurboCfg : envBaseCfg, 0.1, 30);
  const sampler = normalizeZImageSampler(
    typeof ctx.params.sampler === "string" && ctx.params.sampler.trim().length > 0
      ? ctx.params.sampler
      : process.env.COMFYUI_QWEN_GENERATE_SAMPLER ?? process.env.COMFYUI_QWEN_EDIT_SAMPLER
  );
  const scheduler = normalizeZImageScheduler(
    typeof ctx.params.scheduler === "string" && ctx.params.scheduler.trim().length > 0
      ? ctx.params.scheduler
      : process.env.COMFYUI_QWEN_GENERATE_SCHEDULER ?? process.env.COMFYUI_QWEN_EDIT_SCHEDULER
  );
  const denoise = coerceFloat(
    ctx.params.denoise,
    coerceFloat(process.env.COMFYUI_QWEN_GENERATE_DENOISE ?? process.env.COMFYUI_QWEN_EDIT_DENOISE, 1, 0, 1),
    0,
    1
  );
  const seed = chooseSeed(ctx);
  const baseSteps = turboMode ? envBaseSteps : steps;
  const turboSteps = turboMode ? steps : envTurboSteps;
  const baseCfg = turboMode ? envBaseCfg : cfg;
  const turboCfg = turboMode ? cfg : envTurboCfg;
  const auraFlowShift = coerceFloat(
    process.env.COMFYUI_QWEN_GENERATE_AURAFLOW_SHIFT ?? process.env.COMFYUI_QWEN_EDIT_AURAFLOW_SHIFT,
    3.1,
    0,
    12
  );
  const unet =
    process.env.COMFYUI_QWEN_GENERATE_UNET?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_UNET?.trim() ||
    "qwen_image_edit_2511_bf16.safetensors";
  const vae =
    process.env.COMFYUI_QWEN_GENERATE_VAE?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_VAE?.trim() ||
    "qwen_image_vae.safetensors";
  const clip =
    process.env.COMFYUI_QWEN_GENERATE_CLIP?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_CLIP?.trim() ||
    "qwen_2.5_vl_7b_fp8_scaled.safetensors";
  const clipType =
    process.env.COMFYUI_QWEN_GENERATE_CLIP_TYPE?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_CLIP_TYPE?.trim() ||
    "qwen_image";
  const clipDevice =
    process.env.COMFYUI_QWEN_GENERATE_CLIP_DEVICE?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_CLIP_DEVICE?.trim() ||
    "default";
  const unetWeightDType =
    process.env.COMFYUI_QWEN_GENERATE_UNET_WEIGHT_DTYPE?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_UNET_WEIGHT_DTYPE?.trim() ||
    "default";
  const lora =
    process.env.COMFYUI_QWEN_GENERATE_LORA?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_LORA?.trim() ||
    "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors";
  const loraStrength = coerceFloat(
    process.env.COMFYUI_QWEN_GENERATE_LORA_STRENGTH ?? process.env.COMFYUI_QWEN_EDIT_LORA_STRENGTH,
    1,
    0,
    4
  );
  const qwenWorkflowPath =
    process.env.COMFYUI_QWEN_GENERATE_WORKFLOW_PATH?.trim() ||
    process.env.COMFYUI_QWEN_EDIT_WORKFLOW_PATH?.trim() ||
    null;
  const loaded = await loadWorkflowTemplate(qwenWorkflowPath);
  const workflow = loaded ?? DEFAULT_QWEN_EDIT_2511_WORKFLOW;
  const workflowTemplateSource = loaded ? (qwenWorkflowPath as string) : "builtin:qwen-image-edit:2511";
  const referenceLatentsMethod =
    process.env.COMFYUI_QWEN_EDIT_REFERENCE_LATENTS_METHOD?.trim() || "index_timestep_zero";

  if (!resolveComfyEnabled()) {
    return resultWithWarning(buildMockGeneratedSvg(ctx, "Qwen-Image-Edit", prompt), "COMFYUI_ENABLED=false");
  }

  try {
    const result = await withComfyRuntime(async () => {
      const comfy = resolveComfyClient();
      const uploaded = await comfy.uploadImage({
        buffer: ONE_PIXEL_PNG,
        filename: `tribalai_${ctx.runId}_${ctx.nodeId}_seed.png`,
        type: "input",
        overwrite: true
      });
      const placeholders: Record<string, JsonValue> = {
        __PROMPT__: prompt.length > 0 ? prompt : "Generate a detailed cinematic 3D environment concept image.",
        __NEGATIVE_PROMPT__: negativePrompt,
        __INPUT_IMAGE__: uploaded.filename,
        __INPUT_IMAGE2__: uploaded.filename,
        __INPUT_IMAGE3__: uploaded.filename,
        __FILENAME_PREFIX__: `tribalai_qwen_generate_${ctx.runId}_${ctx.nodeId}`,
        __ENABLE_TURBO_MODE__: turboMode,
        __BASE_STEPS__: baseSteps,
        __TURBO_STEPS__: turboSteps,
        __BASE_CFG__: baseCfg,
        __TURBO_CFG__: turboCfg,
        __SEED__: seed,
        __STEPS__: steps,
        __CFG__: cfg,
        __SAMPLER__: sampler,
        __SCHEDULER__: scheduler,
        __DENOISE__: denoise,
        __AURAFLOW_SHIFT__: auraFlowShift,
        __REFERENCE_LATENTS_METHOD__: referenceLatentsMethod,
        __UNET__: unet,
        __VAE__: vae,
        __CLIP__: clip,
        __CLIP_TYPE__: clipType,
        __CLIP_DEVICE__: clipDevice,
        __UNET_WEIGHT_DTYPE__: unetWeightDType,
        __LORA__: lora,
        __LORA_STRENGTH__: loraStrength
      };
      const preferredOutputNodeId =
        process.env.COMFYUI_QWEN_GENERATE_OUTPUT_NODE_ID?.trim() ||
        process.env.COMFYUI_QWEN_EDIT_OUTPUT_NODE_ID?.trim() ||
        "60";
      const executed = await executeComfyWorkflowAndExtractImage({
        ctx,
        workflow,
        placeholders,
        preferredOutputNodeId,
        extraData: {
          tribalai_run_id: ctx.runId,
          tribalai_node_id: ctx.nodeId,
          tribalai_node_type: ctx.nodeType
        },
        timeoutMs: Number(
          process.env.COMFYUI_QWEN_GENERATE_TIMEOUT_MS ??
            process.env.COMFYUI_QWEN_EDIT_TIMEOUT_MS ??
            process.env.COMFYUI_TIMEOUT_MS ??
            360_000
        )
      });
      return { executed, uploaded, placeholders };
    });
    const output = result.executed.outputs[0];
    output.meta = {
      ...(output.meta ?? {}),
      model: "qwen-image-edit",
      mode: "generate",
      prompt: result.placeholders.__PROMPT__,
      negativePrompt,
      seed,
      steps,
      cfg,
      sampler,
      scheduler,
      denoise,
      auraFlowShift,
      turboMode,
      unet,
      vae,
      clip,
      lora: turboMode ? lora : null,
      loraStrength: turboMode ? loraStrength : null,
      workflowTemplateSource,
      comfyInputImage: result.uploaded
    };
    return result.executed;
  } catch (error) {
    if (!resolveMockFallbackAllowed()) throw error;
    const fallback = buildMockGeneratedSvg(ctx, "Qwen-Image-Edit", prompt);
    return resultWithWarning(
      fallback,
      `Comfy Qwen generate failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function executeComfyQwenDistillNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const prompt = await resolvePrompt(ctx);
  const workflowPath = process.env.COMFYUI_QWEN_DISTILL_WORKFLOW_PATH?.trim() || null;
  const loaded = await loadWorkflowTemplate(workflowPath);
  const workflow = loaded ?? DEFAULT_QWEN_DISTILL_WORKFLOW;

  const negativePromptParam = typeof ctx.params.negativePrompt === "string" ? ctx.params.negativePrompt.trim() : "";
  const negativePrompt = negativePromptParam || process.env.COMFYUI_QWEN_DISTILL_NEGATIVE_PROMPT?.trim() || "";

  const envSteps = coerceInt(process.env.COMFYUI_QWEN_DISTILL_STEPS, 10, 1, 100);
  const envCfg = coerceFloat(process.env.COMFYUI_QWEN_DISTILL_CFG, 1, 0.1, 20);
  const envWidth = normalizeQwenDistillDimension(process.env.COMFYUI_QWEN_DISTILL_WIDTH, 1328);
  const envHeight = normalizeQwenDistillDimension(process.env.COMFYUI_QWEN_DISTILL_HEIGHT, 1328);
  const envAuraShift = coerceFloat(process.env.COMFYUI_QWEN_DISTILL_AURAFLOW_SHIFT, 3, 0, 12);

  const steps = coerceInt(ctx.params.steps, envSteps, 1, 100);
  const cfg = coerceFloat(ctx.params.cfg, envCfg, 0.1, 20);
  const width = normalizeQwenDistillDimension(ctx.params.width, envWidth);
  const height = normalizeQwenDistillDimension(ctx.params.height, envHeight);
  const seed = chooseSeed(ctx);
  const sampler = (process.env.COMFYUI_QWEN_DISTILL_SAMPLER?.trim() || "res_multistep");
  const scheduler = (process.env.COMFYUI_QWEN_DISTILL_SCHEDULER?.trim() || "simple");
  const denoise = coerceFloat(process.env.COMFYUI_QWEN_DISTILL_DENOISE, 1, 0, 1);
  const unet = process.env.COMFYUI_QWEN_DISTILL_UNET?.trim() || "qwen_image_distill_full_fp8_e4m3fn.safetensors";
  const vae = process.env.COMFYUI_QWEN_DISTILL_VAE?.trim() || "qwen_image_vae.safetensors";
  const clip = process.env.COMFYUI_QWEN_DISTILL_CLIP?.trim() || "qwen_2.5_vl_7b_fp8_scaled.safetensors";
  const clipType = process.env.COMFYUI_QWEN_DISTILL_CLIP_TYPE?.trim() || "qwen_image";
  const clipDevice = process.env.COMFYUI_QWEN_DISTILL_CLIP_DEVICE?.trim() || "default";
  const unetWeightDType = process.env.COMFYUI_QWEN_DISTILL_UNET_WEIGHT_DTYPE?.trim() || "default";
  const preferredOutputNodeId = process.env.COMFYUI_QWEN_DISTILL_OUTPUT_NODE_ID?.trim() || "60";

  const placeholders: Record<string, JsonValue> = {
    __PROMPT__: prompt.length > 0 ? prompt : "A cinematic stylized 3D environment concept render.",
    __NEGATIVE_PROMPT__: negativePrompt,
    __SEED__: seed,
    __STEPS__: steps,
    __CFG__: cfg,
    __WIDTH__: width,
    __HEIGHT__: height,
    __SAMPLER__: sampler,
    __SCHEDULER__: scheduler,
    __DENOISE__: denoise,
    __AURAFLOW_SHIFT__: envAuraShift,
    __UNET__: unet,
    __VAE__: vae,
    __CLIP__: clip,
    __CLIP_TYPE__: clipType,
    __CLIP_DEVICE__: clipDevice,
    __UNET_WEIGHT_DTYPE__: unetWeightDType,
    __FILENAME_PREFIX__: `tribalai_qwen_distill_${ctx.runId}_${ctx.nodeId}`
  };

  if (!resolveComfyEnabled()) {
    return resultWithWarning(buildMockGeneratedSvg(ctx, "Qwen-Distill", placeholders.__PROMPT__ as string), "COMFYUI_ENABLED=false");
  }

  try {
    const result = await withComfyRuntime(async () =>
      executeComfyWorkflowAndExtractImage({
        ctx,
        workflow,
        placeholders,
        preferredOutputNodeId,
        extraData: {
          tribalai_run_id: ctx.runId,
          tribalai_node_id: ctx.nodeId,
          tribalai_node_type: ctx.nodeType
        },
        timeoutMs: Number(process.env.COMFYUI_QWEN_DISTILL_TIMEOUT_MS ?? process.env.COMFYUI_TIMEOUT_MS ?? 420_000)
      })
    );
    const output = result.outputs[0];
    output.meta = {
      ...(output.meta ?? {}),
      model: "qwen-image-distill",
      mode: "generate",
      prompt: placeholders.__PROMPT__,
      negativePrompt,
      seed,
      steps,
      cfg,
      width,
      height,
      sampler,
      scheduler,
      denoise,
      auraFlowShift: envAuraShift,
      unet,
      vae,
      clip
    };
    return result;
  } catch (error) {
    if (!resolveMockFallbackAllowed()) throw error;
    const fallback = buildMockGeneratedSvg(ctx, "Qwen-Distill", prompt);
    return resultWithWarning(
      fallback,
      `Comfy Qwen distill failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
