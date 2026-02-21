import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";

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
  boxes?: Array<{
    label?: string;
    score?: number;
    bbox?: number[];
  }>;
  raw_json_path?: string;
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

function normalizeBoxesForApp(rawBoxes: BoxesPayload["boxes"]) {
  const normalized: Array<{ label: string; score: number; bbox: [number, number, number, number] }> = [];
  for (const item of rawBoxes ?? []) {
    if (!item || !Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
    const bbox = item.bbox.map((value) => Number(value));
    if (bbox.some((value) => !Number.isFinite(value))) continue;
    normalized.push({
      label: typeof item.label === "string" ? item.label : "object",
      score: Number.isFinite(item.score) ? Number(item.score) : 0.5,
      bbox: [bbox[0], bbox[1], bbox[2], bbox[3]]
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
  const now = new Date().toISOString();

  const outputDir = path.join(
    process.cwd(),
    ".local-storage",
    "projects",
    ctx.projectId,
    "model_outputs",
    "groundingdino",
    "runs",
    ctx.runId,
    "nodes",
    ctx.nodeId
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
  const parsedBoxesJson = safeJsonParse<BoxesPayload>(boxesJsonRaw);
  if (!parsedBoxesJson) {
    throw new Error(`GroundingDINO boxes JSON is invalid: ${boxesJsonPath}`);
  }

  const normalizedBoxes = normalizeBoxesForApp(parsedBoxesJson.boxes);
  const boxesPayload = {
    model: "groundingdino-python",
    runner: "conda",
    condaEnv,
    textPrompt:
      parsedBoxesJson.text_prompt && parsedBoxesJson.text_prompt.trim().length > 0
        ? parsedBoxesJson.text_prompt
        : prompt,
    threshold,
    sourceImageArtifactId: sourceImage.artifactId,
    sourceImageHash: sourceImage.hash,
    boxes: normalizedBoxes,
    boxesCount: normalizedBoxes.length,
    outputDir,
    rawJsonPath: parsedBoxesJson.raw_json_path ?? manifest.raw_json_path ?? null,
    createdAt: now
  };
  const boxesBuffer = createJsonBuffer(boxesPayload);

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
        boxesCount: normalizedBoxes.length,
        prompt: boxesPayload.textPrompt,
        threshold
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
        prompt: boxesPayload.textPrompt,
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
