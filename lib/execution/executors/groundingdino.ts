import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mimeFromExtension(filePath: string) {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function resolveInputExtension(ctx: NodeExecutionContext, sourceMimeType: string, sourceMeta: Record<string, unknown>) {
  if (typeof sourceMeta.filename === "string") {
    const ext = path.extname(sourceMeta.filename).replace(".", "").trim().toLowerCase();
    if (ext) return ext;
  }

  if (sourceMimeType.includes("png")) return "png";
  if (sourceMimeType.includes("webp")) return "webp";
  if (sourceMimeType.includes("svg")) return "svg";
  if (sourceMimeType.includes("jpeg") || sourceMimeType.includes("jpg")) return "jpg";

  const storageExt = path.extname(ctx.inputs.image?.[0]?.storageKey ?? "").replace(".", "").trim().toLowerCase();
  return storageExt || "jpg";
}

function getLocalStorageRoot() {
  return process.env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), ".local-storage");
}

async function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `GroundingDINO process failed (exit=${code})\n` +
              `cmd: ${command} ${args.join(" ")}\n` +
              `stderr: ${stderr.slice(-5000)}`
          )
        );
      }
    });
  });
}

interface ManifestPayload {
  overlay_path?: string;
  boxes_json_path?: string;
  raw_json_path?: string;
  boxes_count?: number;
  text_prompt?: string;
}

interface BoxesPayload {
  text_prompt?: string;
  box_threshold?: number;
  text_threshold?: number | null;
  image_path?: string;
  image_size?: { width?: number; height?: number } | null;
  size?: number[];
  boxes?: Array<{
    label?: string;
    score?: number;
    bbox?: number[];
    box_cxcywh_norm?: number[];
    box_xyxy_norm?: number[];
    box_xyxy?: number[];
    box_xyxy_int?: number[];
    box_xywh?: number[];
  }>;
  raw_json_path?: string;
}

function readNumberArray(value: unknown, length: number) {
  if (!Array.isArray(value) || value.length !== length) return null;
  const casted = value.map((item) => Number(item));
  return casted.every((item) => Number.isFinite(item)) ? casted : null;
}

function parseImageSize(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const asRecord = payload as Record<string, unknown>;
  const imageSize = asRecord.image_size;
  if (imageSize && typeof imageSize === "object" && !Array.isArray(imageSize)) {
    const width = Number((imageSize as Record<string, unknown>).width);
    const height = Number((imageSize as Record<string, unknown>).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  const size = asRecord.size;
  if (Array.isArray(size) && size.length === 2) {
    const height = Number(size[0]);
    const width = Number(size[1]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function normalizeBoxFromPayload(
  item: Record<string, unknown>,
  imageSize: { width: number; height: number } | null
) {
  const cxcywhNorm = readNumberArray(item.box_cxcywh_norm, 4);
  if (cxcywhNorm) {
    const [cx, cy, w, h] = cxcywhNorm;
    return [cx - w / 2, cy - h / 2, w, h] as [number, number, number, number];
  }

  const xyxyNorm = readNumberArray(item.box_xyxy_norm, 4);
  if (xyxyNorm) {
    const [x1, y1, x2, y2] = xyxyNorm;
    return [x1, y1, x2 - x1, y2 - y1] as [number, number, number, number];
  }

  const bbox = readNumberArray(item.bbox, 4);
  if (bbox) {
    const [a, b, c, d] = bbox;
    if ([a, b, c, d].every((value) => value >= 0 && value <= 1)) {
      return [a - c / 2, b - d / 2, c, d] as [number, number, number, number];
    }
    return [a, b, c, d] as [number, number, number, number];
  }

  const xyxyInt = readNumberArray(item.box_xyxy_int, 4);
  if (xyxyInt && imageSize) {
    const [x1, y1, x2, y2] = xyxyInt;
    return [
      x1 / imageSize.width,
      y1 / imageSize.height,
      (x2 - x1) / imageSize.width,
      (y2 - y1) / imageSize.height
    ] as [number, number, number, number];
  }

  const xyxy = readNumberArray(item.box_xyxy, 4);
  if (xyxy && imageSize) {
    const [x1, y1, x2, y2] = xyxy;
    return [
      x1 / imageSize.width,
      y1 / imageSize.height,
      (x2 - x1) / imageSize.width,
      (y2 - y1) / imageSize.height
    ] as [number, number, number, number];
  }

  const xywh = readNumberArray(item.box_xywh, 4);
  if (xywh && imageSize) {
    const [x, y, w, h] = xywh;
    return [x / imageSize.width, y / imageSize.height, w / imageSize.width, h / imageSize.height] as [
      number,
      number,
      number,
      number
    ];
  }

  return null;
}

async function loadManifest(outputDir: string, processStdout: string): Promise<ManifestPayload> {
  const manifestPath = path.join(outputDir, "result_manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = safeJsonParse<ManifestPayload>(raw);
    if (parsed) return parsed;
  } catch {
    // Ignore and try stdout fallback.
  }

  const lines = processStdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = safeJsonParse<ManifestPayload>(lines[i]);
    if (parsed) return parsed;
  }
  return {};
}

function normalizeBoxesForApp(rawBoxes: BoxesPayload["boxes"], imageSize: { width: number; height: number } | null) {
  const normalized: Array<{ label: string; score: number; bbox: [number, number, number, number] }> = [];
  for (const item of rawBoxes ?? []) {
    if (!item || typeof item !== "object") continue;
    const bbox = normalizeBoxFromPayload(item as Record<string, unknown>, imageSize);
    if (!bbox) continue;
    normalized.push({
      label: typeof item.label === "string" ? item.label : "object",
      score: Number.isFinite(item.score) ? Number(item.score) : 0.5,
      bbox
    });
  }
  return normalized;
}

export async function executeGroundingDinoNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const sourceImage = ctx.inputs.image?.[0];
  if (!sourceImage) {
    throw new Error("GroundingDINO requires an image input");
  }

  const modelRoot = path.join(process.cwd(), "models", "GroundingDINO");
  const scriptRelativePath = process.env.GROUNDING_DINO_WEB_SCRIPT ?? "demo/inference_for_webapp.py";
  const configRelativePath =
    process.env.GROUNDING_DINO_CONFIG_RELATIVE ?? "groundingdino/config/GroundingDINO_SwinT_OGC.py";
  const checkpointRelativePath =
    process.env.GROUNDING_DINO_CHECKPOINT_RELATIVE ?? "weights/groundingdino_swint_ogc.pth";
  const condaEnv = process.env.GROUNDING_DINO_CONDA_ENV ?? "grounding_dino";
  const command = process.env.GROUNDING_DINO_CONDA_COMMAND ?? "conda";

  const threshold =
    typeof ctx.params.threshold === "number" && Number.isFinite(ctx.params.threshold) ? ctx.params.threshold : 0.35;
  const textThreshold =
    typeof ctx.params.textThreshold === "number" && Number.isFinite(ctx.params.textThreshold)
      ? ctx.params.textThreshold
      : 0.25;
  const prompt = typeof ctx.params.prompt === "string" ? ctx.params.prompt.trim() : "";
  const tokenSpans = typeof ctx.params.tokenSpans === "string" ? ctx.params.tokenSpans.trim() : "";

  const outputDir = path.join(
    getLocalStorageRoot(),
    "projects",
    ctx.projectId,
    "runs",
    ctx.runId,
    "nodes",
    ctx.nodeId,
    "groundingdino"
  );
  await fs.mkdir(outputDir, { recursive: true });

  const inputBuffer = await ctx.loadInputBuffer(sourceImage);
  const extension = resolveInputExtension(ctx, sourceImage.mimeType, sourceImage.meta ?? {});
  const inputPath = path.join(outputDir, `input.${extension}`);
  await fs.writeFile(inputPath, inputBuffer);

  const args = [
    "run",
    "-n",
    condaEnv,
    "python",
    scriptRelativePath,
    "-c",
    configRelativePath,
    "-p",
    checkpointRelativePath,
    "-i",
    inputPath,
    "-o",
    outputDir,
    "--box_threshold",
    String(threshold),
    "--text_threshold",
    String(textThreshold)
  ];

  if (prompt) {
    args.push("-t", prompt);
  }
  if (tokenSpans) {
    args.push("--token_spans", tokenSpans);
  }
  if (process.env.GROUNDING_DINO_CPU_ONLY === "true") {
    args.push("--cpu-only");
  }

  const processResult = await runProcess(command, args, modelRoot);
  const manifest = await loadManifest(outputDir, processResult.stdout);
  const overlayPath = manifest.overlay_path ?? path.join(outputDir, "detected_overlay.jpg");
  const boxesJsonPath = manifest.boxes_json_path ?? path.join(outputDir, "detections_web.json");

  const overlayBuffer = await fs.readFile(overlayPath).catch((error) => {
    throw new Error(`GroundingDINO overlay image not found at ${overlayPath}: ${(error as Error).message}`);
  });
  const boxesJsonRaw = await fs.readFile(boxesJsonPath, "utf8").catch((error) => {
    throw new Error(`GroundingDINO boxes JSON not found at ${boxesJsonPath}: ${(error as Error).message}`);
  });
  const parsedWebJson = safeJsonParse<BoxesPayload>(boxesJsonRaw);
  if (!parsedWebJson) {
    throw new Error(`GroundingDINO boxes JSON is invalid: ${boxesJsonPath}`);
  }

  const preferredConfigPath =
    manifest.raw_json_path ??
    parsedWebJson.raw_json_path ??
    path.join(outputDir, "detections_full.json");

  let configJsonPath = boxesJsonPath;
  let configJsonRaw = boxesJsonRaw;
  let parsedConfigJson: BoxesPayload = parsedWebJson;

  try {
    const rawJsonRaw = await fs.readFile(preferredConfigPath, "utf8");
    const parsedRawJson = safeJsonParse<BoxesPayload>(rawJsonRaw);
    if (parsedRawJson) {
      configJsonPath = preferredConfigPath;
      configJsonRaw = rawJsonRaw;
      parsedConfigJson = parsedRawJson;
    }
  } catch {
    // Keep web json fallback.
  }

  const imageSize = parseImageSize(parsedConfigJson) ?? parseImageSize(parsedWebJson);
  const normalizedBoxes = normalizeBoxesForApp(parsedConfigJson.boxes ?? parsedWebJson.boxes, imageSize);
  const resolvedPrompt =
    parsedConfigJson.text_prompt && parsedConfigJson.text_prompt.trim().length > 0
      ? parsedConfigJson.text_prompt
      : parsedWebJson.text_prompt && parsedWebJson.text_prompt.trim().length > 0
        ? parsedWebJson.text_prompt
        : prompt;

  const boxesBuffer = Buffer.from(configJsonRaw, "utf8");

  const outputs: ExecutorOutputArtifact[] = [
    {
      outputId: "boxes",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: boxesBuffer,
      meta: {
        outputKey: "boxes",
        hidden: true,
        sourceImageArtifactId: sourceImage.artifactId,
        sourceImageHash: sourceImage.hash,
        sourceImageStorageKey: sourceImage.storageKey,
        sourceImagePath: inputPath,
        image_path: inputPath,
        rawJsonPath: preferredConfigPath,
        boxesConfigPath: configJsonPath,
        boxesCount: normalizedBoxes.length,
        prompt: resolvedPrompt,
        threshold,
        configFormat: configJsonPath.endsWith("detections_full.json") ? "detections_full" : "detections_web"
      }
    },
    {
      outputId: "overlay",
      kind: "image",
      mimeType: mimeFromExtension(overlayPath),
      extension: path.extname(overlayPath).replace(".", "") || "jpg",
      buffer: overlayBuffer,
      preview: {
        extension: path.extname(overlayPath).replace(".", "") || "jpg",
        mimeType: mimeFromExtension(overlayPath),
        buffer: overlayBuffer
      },
      meta: {
        outputKey: "overlay",
        sourceImageArtifactId: sourceImage.artifactId,
        sourceImageHash: sourceImage.hash,
        prompt: resolvedPrompt,
        threshold,
        boxesCount: normalizedBoxes.length
      }
    }
  ];

  for (const output of outputs) {
    if (!output.meta) output.meta = {};
    output.meta.contentHash = hashBuffer(output.buffer);
  }

  return {
    mode: "detection",
    outputs
  };
}
