import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { env } from "@/lib/env";
import { NodeExecutionContext, NodeExecutionResult, ResolvedArtifactInput } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";
import { buildDetectionOverlaySvg, NormalizedBox } from "@/lib/execution/executors/svg";
import { getDefaultSam2Config, resolveSam2ConfigPath } from "@/lib/sam2/configs";

type Sam2Mode = "guided" | "full";

interface Sam2Command {
  command: string;
  args: string[];
  scriptPath: string;
}

function quoteShellArg(value: string) {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/:.=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatCommandLine(command: string, args: string[]) {
  return [quoteShellArg(command), ...args.map((arg) => quoteShellArg(arg))].join(" ");
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getLocalStorageRoot() {
  return env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), ".local-storage");
}

function getSam2RepoRoot() {
  return env.SAM2_REPO_ROOT || path.join(process.cwd(), "models", "sam2");
}

function getSam2ToolsDir() {
  return env.SAM2_TOOLS_DIR || path.join(getSam2RepoRoot(), "tools");
}

function getSam2Checkpoint() {
  return env.SAM2_CHECKPOINT || path.join(getSam2RepoRoot(), "checkpoints", "sam2.1_hiera_large.pt");
}

function extensionFromMime(mimeType: string) {
  const lowered = mimeType.toLowerCase();
  if (lowered.includes("png")) return "png";
  if (lowered.includes("webp")) return "webp";
  if (lowered.includes("svg")) return "svg";
  return "jpg";
}

function mimeFromPath(filePath: string) {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function readNumberArray(value: unknown, length: number) {
  if (!Array.isArray(value) || value.length !== length) return null;
  const casted = value.map((item) => Number(item));
  return casted.every((item) => Number.isFinite(item)) ? casted : null;
}

function parseImageSize(payload: Record<string, unknown>) {
  const imageSize = payload.image_size;
  if (imageSize && typeof imageSize === "object" && !Array.isArray(imageSize)) {
    const width = Number((imageSize as Record<string, unknown>).width);
    const height = Number((imageSize as Record<string, unknown>).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  const size = payload.size;
  if (Array.isArray(size) && size.length === 2) {
    const height = Number(size[0]);
    const width = Number(size[1]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function parseBoxes(payload: unknown): NormalizedBox[] {
  if (!payload || typeof payload !== "object") return [];
  const payloadObj = payload as Record<string, unknown>;
  const maybeBoxes = payloadObj.boxes;
  if (!Array.isArray(maybeBoxes)) return [];
  const imageSize = parseImageSize(payloadObj);

  const boxes: NormalizedBox[] = [];
  for (const item of maybeBoxes) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    let coords: [number, number, number, number] | null = null;

    const bbox = readNumberArray(obj.bbox, 4);
    if (bbox) {
      const [a, b, c, d] = bbox;
      coords = [a - c / 2, b - d / 2, c, d];
    }

    if (!coords) {
      const cxcywhNorm = readNumberArray(obj.box_cxcywh_norm, 4);
      if (cxcywhNorm) {
        const [cx, cy, w, h] = cxcywhNorm;
        coords = [cx - w / 2, cy - h / 2, w, h];
      }
    }

    if (!coords) {
      const xyxyNorm = readNumberArray(obj.box_xyxy_norm, 4);
      if (xyxyNorm) {
        const [x1, y1, x2, y2] = xyxyNorm;
        coords = [x1, y1, x2 - x1, y2 - y1];
      }
    }

    if (!coords && imageSize) {
      const xyxyInt = readNumberArray(obj.box_xyxy_int, 4);
      if (xyxyInt) {
        const [x1, y1, x2, y2] = xyxyInt;
        coords = [
          x1 / imageSize.width,
          y1 / imageSize.height,
          (x2 - x1) / imageSize.width,
          (y2 - y1) / imageSize.height
        ];
      }
    }

    if (!coords && imageSize) {
      const xyxy = readNumberArray(obj.box_xyxy, 4);
      if (xyxy) {
        const [x1, y1, x2, y2] = xyxy;
        coords = [
          x1 / imageSize.width,
          y1 / imageSize.height,
          (x2 - x1) / imageSize.width,
          (y2 - y1) / imageSize.height
        ];
      }
    }

    if (!coords) continue;
    boxes.push({
      label: typeof obj.label === "string" ? obj.label : "object",
      score: Number.isFinite(obj.score) ? Number(obj.score) : 0.6,
      bbox: coords
    });
  }
  return boxes;
}

async function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
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
            `SAM2 process failed (exit=${code})\n` +
              `cmd: ${command} ${args.join(" ")}\n` +
              `stderr: ${stderr.slice(-8000)}`
          )
        );
      }
    });
  });
}

function resolveRequestedMode(ctx: NodeExecutionContext, hasBoxesConfig: boolean): Sam2Mode {
  const modeParam = typeof ctx.params.mode === "string" ? ctx.params.mode : "auto";
  if (modeParam === "guided") return "guided";
  if (modeParam === "full") return "full";
  return hasBoxesConfig ? "guided" : "full";
}

async function materializeInputImage(
  ctx: NodeExecutionContext,
  imageInput: ResolvedArtifactInput,
  outputDir: string
) {
  const extension = extensionFromMime(imageInput.mimeType);
  const imagePath = path.join(outputDir, `input_image.${extension}`);
  const imageBuffer = await ctx.loadInputBuffer(imageInput);
  await fs.writeFile(imagePath, imageBuffer);
  return imagePath;
}

async function materializeBoxesConfig(
  ctx: NodeExecutionContext,
  boxesInput: ResolvedArtifactInput,
  outputDir: string
) {
  const boxesPath = path.join(outputDir, "boxes_config.json");
  const buffer = await ctx.loadInputBuffer(boxesInput);
  await fs.writeFile(boxesPath, buffer);
  let commandConfigPath = boxesPath;

  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
    const fullConfigPath =
      typeof parsed.raw_json_path === "string"
        ? parsed.raw_json_path
        : typeof parsed.rawJsonPath === "string"
          ? parsed.rawJsonPath
          : null;

    if (fullConfigPath) {
      try {
        await fs.access(fullConfigPath);
        commandConfigPath = fullConfigPath;
        const rawFull = await fs.readFile(fullConfigPath);
        await fs.writeFile(boxesPath, rawFull);
        const parsedFull = JSON.parse(rawFull.toString("utf8")) as Record<string, unknown>;
        return { boxesPath, parsed: parsedFull, commandConfigPath };
      } catch {
        // Keep parsed fallback from artifact content.
      }
    }

    return { boxesPath, parsed, commandConfigPath };
  } catch {
    return { boxesPath, parsed: null as Record<string, unknown> | null, commandConfigPath };
  }
}

async function resolveImagePath(params: {
  ctx: NodeExecutionContext;
  imageInput: ResolvedArtifactInput | null;
  boxesPayload: Record<string, unknown> | null;
  outputDir: string;
}) {
  const { ctx, imageInput, boxesPayload, outputDir } = params;

  if (imageInput) {
    return await materializeInputImage(ctx, imageInput, outputDir);
  }

  const imageFromConfig =
    boxesPayload && typeof boxesPayload.image_path === "string"
      ? boxesPayload.image_path
      : boxesPayload && typeof boxesPayload.sourceImagePath === "string"
        ? boxesPayload.sourceImagePath
        : boxesPayload && typeof boxesPayload.source_image_path === "string"
          ? boxesPayload.source_image_path
          : null;

  if (imageFromConfig) {
    try {
      await fs.access(imageFromConfig);
      return imageFromConfig;
    } catch {
      // Fall through to error.
    }
  }

  throw new Error("No input image provided and config JSON does not contain an image path.");
}

function buildPythonInvocation(scriptPath: string): Pick<Sam2Command, "command" | "args"> {
  const useConda = (process.env.SAM2_USE_CONDA ?? "true").toLowerCase() !== "false";
  const condaEnvRaw = process.env.SAM2_CONDA_ENV?.trim() ?? "";
  const condaEnv =
    condaEnvRaw.length > 0 && condaEnvRaw.toLowerCase() !== "none"
      ? condaEnvRaw
      : "sam2";
  if (useConda) {
    const condaCommand = process.env.SAM2_CONDA_COMMAND?.trim() || "conda";
    return {
      command: condaCommand,
      args: ["run", "-n", condaEnv, "python", scriptPath]
    };
  }
  const pythonCommand = process.env.SAM2_PYTHON_COMMAND?.trim() || "python";
  return {
    command: pythonCommand,
    args: [scriptPath]
  };
}

async function buildSam2Command(params: {
  ctx: NodeExecutionContext;
  mode: Sam2Mode;
  resolvedImagePath: string;
  boxesConfigPath: string | null;
  outputDir: string;
}) {
  const { ctx, mode, resolvedImagePath, boxesConfigPath, outputDir } = params;
  const toolsDir = getSam2ToolsDir();
  const checkpointPath = getSam2Checkpoint();
  const cfgSelection =
    typeof ctx.params.sam2Cfg === "string" && ctx.params.sam2Cfg.trim().length > 0
      ? ctx.params.sam2Cfg.trim()
      : getDefaultSam2Config();
  const resolvedCfg = await resolveSam2ConfigPath(cfgSelection);
  const resolvedCfgPath =
    mode === "guided"
      ? path.join(getSam2RepoRoot(), "sam2", "configs", "sam2.1", path.basename(resolvedCfg.absolutePath))
      : path.join(getSam2RepoRoot(), "sam2", "configs", "sam2.1", path.basename(resolvedCfg.absolutePath));

  if (mode === "guided" && !boxesConfigPath) {
    throw new Error("Requires ObjectDetection descriptor JSON input.");
  }

  const scriptPath = path.join(toolsDir, "inference_for_webapp.py");

  const base = buildPythonInvocation(scriptPath);
  const args = [...base.args, "--mode", mode];

  if (mode === "guided") {
    args.push(
      "--config",
      boxesConfigPath as string,
      "--output",
      path.join(outputDir, "masks_dino"),
      "--sam2_cfg",
      resolvedCfgPath,
      "--sam2_checkpoint",
      checkpointPath,
      "--overlay",
      path.join("..", "overlays", "overlay.jpg"),
      "--overlay-alpha",
      String(clamp(Number(ctx.params.overlayAlpha ?? 0.6), 0, 1))
    );
  } else {
    const pointsPerSide = Math.round(
      clamp(Number(ctx.params.pointsPerSide ?? 64), 4, 256)
    );
    const predIouThresh = clamp(Number(ctx.params.predIouThresh ?? 0.7), 0, 1);
    const stabilityScoreThresh = clamp(Number(ctx.params.stabilityScoreThresh ?? 0.9), 0, 1);
    const cropNLayers = Math.round(clamp(Number(ctx.params.cropNLayers ?? 1), 0, 8));
    const overlayAlpha = clamp(Number(ctx.params.overlayAlpha ?? 0.6), 0, 1);

    args.push(
      "--image",
      resolvedImagePath,
      "--output",
      path.join(outputDir, "masks"),
      "--sam2_cfg",
      resolvedCfgPath,
      "--sam2_checkpoint",
      checkpointPath,
      "--points-per-side",
      String(pointsPerSide),
      "--pred-iou-thresh",
      String(predIouThresh),
      "--stability-score-thresh",
      String(stabilityScoreThresh),
      "--crop-n-layers",
      String(cropNLayers),
      "--overlay",
      path.join("..", "overlays", "overlay.jpg"),
      "--overlay-alpha",
      String(overlayAlpha)
    );
  }

  return {
    command: base.command,
    args,
    scriptPath
  } satisfies Sam2Command;
}

async function collectRealOutputs(params: {
  mode: Sam2Mode;
  outputDir: string;
  command: Sam2Command;
  resolvedImagePath: string;
  sourceImageArtifactId: string | null;
  sourceImageHash: string | null;
  sourceImageStorageKey: string | null;
  boxesPayload: Record<string, unknown> | null;
  warnings: string[];
}) {
  const masksDir = path.join(params.outputDir, params.mode === "guided" ? "masks_dino" : "masks");
  const overlaysDir = path.join(params.outputDir, "overlays");
  await fs.mkdir(overlaysDir, { recursive: true });

  const entries = await fs.readdir(masksDir).catch(() => []);
  const maskCandidates = entries
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort((a, b) => a.localeCompare(b));
  if (maskCandidates.length === 0) {
    throw new Error(`SegmentScene produced no masks in ${masksDir}`);
  }

  const maskPath = path.join(masksDir, maskCandidates[maskCandidates.length - 1]);
  const maskBuffer = await fs.readFile(maskPath);

  const imageEntries = entries.filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name));
  const overlayEntries = await fs.readdir(overlaysDir).catch(() => []);
  const overlayImageEntries = overlayEntries.filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name));
  const overlayCandidateInOverlays =
    overlayImageEntries.find((name) => /overlay|blend|composite/i.test(name)) ??
    overlayImageEntries.find((name) => /^overlay\.(jpg|jpeg|png|webp)$/i.test(name)) ??
    null;
  const overlayCandidateInMasks =
    imageEntries.find((name) => /overlay|blend|composite/i.test(name)) ??
    imageEntries.find((name) => /^overlay\.(jpg|jpeg|png|webp)$/i.test(name)) ??
    null;
  const overlayPath = overlayCandidateInOverlays
    ? path.join(overlaysDir, overlayCandidateInOverlays)
    : overlayCandidateInMasks
      ? path.join(masksDir, overlayCandidateInMasks)
      : null;
  const overlayBuffer = overlayPath ? await fs.readFile(overlayPath) : maskBuffer;
  const overlayMimeType = overlayPath ? mimeFromPath(overlayPath) : "image/png";
  const overlayExt = overlayPath ? path.extname(overlayPath).replace(".", "") : "png";
  const sourceImageBuffer = await fs.readFile(params.resolvedImagePath).catch(() => null);
  const sourceImageMime = mimeFromPath(params.resolvedImagePath);
  const sourceImageExt = path.extname(params.resolvedImagePath).replace(".", "") || "jpg";
  const maskPaths = maskCandidates.map((name) => path.join(masksDir, name));

  const overlayForPreviewBuffer = overlayBuffer ?? maskBuffer;
  const overlayForPreviewMime = overlayBuffer ? overlayMimeType : "image/png";
  const overlayForPreviewExt = overlayBuffer ? overlayExt : "png";
  const selectedCfg = params.command.args[params.command.args.indexOf("--sam2_cfg") + 1] ?? null;
  const checkpoint = params.command.args[params.command.args.indexOf("--sam2_checkpoint") + 1] ?? null;
  const boxesCount =
    params.boxesPayload && Array.isArray(params.boxesPayload.boxes)
      ? params.boxesPayload.boxes.length
      : null;

  const configPayload = {
    model: "sam2-python",
    mode: params.mode,
    command: [params.command.command, ...params.command.args].join(" "),
    script: path.basename(params.command.scriptPath),
    outputDir: params.outputDir,
    sourceImagePath: params.resolvedImagePath,
    sourceImageMime,
    sourceImageExt,
    sourceImageArtifactId: params.sourceImageArtifactId,
    sourceImageHash: params.sourceImageHash,
    sourceImageStorageKey: params.sourceImageStorageKey,
    masksDir,
    maskPaths,
    masksCount: maskCandidates.length,
    maskPreviewPath: maskPath,
    overlayPath: overlayPath ?? maskPath,
    overlayMimeType: overlayForPreviewMime,
    overlayExt: overlayForPreviewExt,
    selectedCfg,
    checkpoint,
    boxesCount,
    warnings: params.warnings,
    createdAt: new Date().toISOString()
  };
  const configBuffer = createJsonBuffer(configPayload);
  const legacyMasksDirPayload = {
    mode: params.mode,
    masksDir,
    maskPaths,
    masksCount: maskCandidates.length,
    sourceImagePath: params.resolvedImagePath,
    sourceImageArtifactId: params.sourceImageArtifactId,
    sourceImageHash: params.sourceImageHash,
    sourceImageStorageKey: params.sourceImageStorageKey,
    createdAt: new Date().toISOString()
  };
  const outputs: NodeExecutionResult["outputs"] = [
    {
      outputId: "config",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      buffer: configBuffer,
      preview: {
        extension: overlayForPreviewExt,
        mimeType: overlayForPreviewMime,
        buffer: overlayForPreviewBuffer
      },
      meta: {
        outputKey: "config",
        mode: params.mode,
        selectedCfg,
        checkpoint,
        masksDir,
        masksCount: maskCandidates.length,
        sourceImagePath: params.resolvedImagePath,
        sourceImageArtifactId: params.sourceImageArtifactId,
        sourceImageHash: params.sourceImageHash,
        sourceImageStorageKey: params.sourceImageStorageKey,
        contentHash: hashBuffer(configBuffer)
      }
    },
    ...(sourceImageBuffer
      ? [
          {
            outputId: "image",
            kind: "image" as const,
            mimeType: sourceImageMime,
            extension: sourceImageExt,
            hidden: true,
            buffer: sourceImageBuffer,
            preview: {
              extension: sourceImageExt,
              mimeType: sourceImageMime,
              buffer: sourceImageBuffer
            },
            meta: {
              outputKey: "image",
              hidden: true,
              mode: params.mode,
              sourcePath: params.resolvedImagePath,
              sourceImageArtifactId: params.sourceImageArtifactId,
              sourceImageHash: params.sourceImageHash,
              sourceImageStorageKey: params.sourceImageStorageKey,
              contentHash: hashBuffer(sourceImageBuffer)
            }
          }
        ]
      : []),
    {
      outputId: "masksDir",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer(legacyMasksDirPayload),
      meta: {
        outputKey: "masksDir",
        hidden: true,
        mode: params.mode,
        masksDir,
        masksCount: maskCandidates.length
      }
    },
    {
      outputId: "overlay",
      kind: "image",
      mimeType: overlayForPreviewMime,
      extension: overlayForPreviewExt,
      hidden: true,
      buffer: overlayForPreviewBuffer,
      preview: {
        extension: overlayForPreviewExt,
        mimeType: overlayForPreviewMime,
        buffer: overlayForPreviewBuffer
      },
      meta: {
        outputKey: "overlay",
        hidden: true,
        mode: params.mode,
        sourcePath: overlayPath ?? maskPath,
        fallbackFromMask: overlayPath ? false : true,
        contentHash: hashBuffer(overlayForPreviewBuffer)
      }
    },
    {
      outputId: "meta",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer({
        ...configPayload,
        kind: "meta"
      }),
      meta: {
        outputKey: "meta",
        hidden: true,
        mode: params.mode
      }
    }
  ];

  if (overlayBuffer && overlayExt && overlayMimeType) {
    const copiedOverlayPath = path.join(overlaysDir, `overlay.${overlayExt}`);
    if (overlayPath && path.resolve(overlayPath) !== path.resolve(copiedOverlayPath)) {
      await fs.copyFile(overlayPath, copiedOverlayPath).catch(() => {
        // Keep working even if copy fails.
      });
    } else {
      await fs.writeFile(copiedOverlayPath, overlayBuffer).catch(() => {
        // Keep working even if write fails.
      });
    }
  }

  return outputs;
}

async function buildMockOutputs(params: {
  mode: Sam2Mode;
  ctx: NodeExecutionContext;
  imageInput: ResolvedArtifactInput | null;
  resolvedImagePath: string;
  sourceImageArtifactId: string | null;
  sourceImageHash: string | null;
  sourceImageStorageKey: string | null;
  boxesPayload: Record<string, unknown> | null;
  warnings: string[];
}) {
  const boxes = parseBoxes(params.boxesPayload);
  const overlayBuffer = Buffer.from(
    buildDetectionOverlaySvg({
      title: `SegmentScene • ${params.mode === "guided" ? "Guided segmentation" : "Full segmentation"}`,
      boxes: boxes.length > 0 ? boxes : [{ label: "segment", score: 0.8, bbox: [0.18, 0.17, 0.5, 0.46] }]
    }),
    "utf8"
  );

  let sourceImageMime = "image/svg+xml";
  let sourceImageExt = "svg";
  if (params.imageInput) {
    sourceImageMime = params.imageInput.mimeType;
    sourceImageExt = extensionFromMime(params.imageInput.mimeType);
  }

  const configPayload = {
    model: "sam2-mock",
    mode: params.mode,
    warnings: params.warnings,
    sourceImagePath: params.resolvedImagePath,
    sourceImageMime,
    sourceImageExt,
    sourceImageArtifactId: params.sourceImageArtifactId,
    sourceImageHash: params.sourceImageHash,
    sourceImageStorageKey: params.sourceImageStorageKey,
    masksDir: path.join(path.dirname(params.resolvedImagePath), params.mode === "guided" ? "masks_dino" : "masks"),
    maskPaths: [] as string[],
    masksCount: 1,
    maskPreviewPath: null,
    overlayPath: null,
    overlayMimeType: "image/svg+xml",
    overlayExt: "svg",
    boxesCount: boxes.length,
    createdAt: new Date().toISOString(),
    mock: true
  };
  const configBuffer = createJsonBuffer(configPayload);
  const sourceImageBuffer = params.imageInput ? await params.ctx.loadInputBuffer(params.imageInput) : null;

  return [
    {
      outputId: "config",
      kind: "json" as const,
      mimeType: "application/json",
      extension: "json",
      buffer: configBuffer,
      preview: {
        extension: "svg",
        mimeType: "image/svg+xml",
        buffer: overlayBuffer
      },
      meta: {
        outputKey: "config",
        mode: params.mode,
        sourceImageArtifactId: params.sourceImageArtifactId,
        sourceImageHash: params.sourceImageHash,
        sourceImageStorageKey: params.sourceImageStorageKey,
        sourceImagePath: params.resolvedImagePath,
        masksDir: configPayload.masksDir,
        masksCount: configPayload.masksCount,
        contentHash: hashBuffer(configBuffer)
      }
    },
    ...(sourceImageBuffer
      ? [
          {
            outputId: "image",
            kind: "image" as const,
            mimeType: sourceImageMime,
            extension: sourceImageExt,
            hidden: true,
            buffer: sourceImageBuffer,
            preview: {
              extension: sourceImageExt,
              mimeType: sourceImageMime,
              buffer: sourceImageBuffer
            },
            meta: {
              outputKey: "image",
              hidden: true,
              mode: params.mode,
              sourceImageArtifactId: params.sourceImageArtifactId,
              sourceImageHash: params.sourceImageHash,
              sourceImageStorageKey: params.sourceImageStorageKey,
              sourceImagePath: params.resolvedImagePath,
              contentHash: hashBuffer(sourceImageBuffer)
            }
          }
        ]
      : []),
    {
      outputId: "masksDir",
      kind: "json" as const,
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer({
        mode: params.mode,
        masksDir: configPayload.masksDir,
        maskPaths: [] as string[],
        masksCount: 1,
        sourceImagePath: params.resolvedImagePath,
        sourceImageArtifactId: params.sourceImageArtifactId,
        sourceImageHash: params.sourceImageHash,
        sourceImageStorageKey: params.sourceImageStorageKey,
        createdAt: configPayload.createdAt,
        mock: true
      }),
      meta: {
        outputKey: "masksDir",
        hidden: true,
        mode: params.mode,
        masksDir: configPayload.masksDir,
        masksCount: 1
      }
    },
    {
      outputId: "overlay",
      kind: "image" as const,
      mimeType: "image/svg+xml",
      extension: "svg",
      hidden: true,
      buffer: overlayBuffer,
      preview: {
        extension: "svg",
        mimeType: "image/svg+xml",
        buffer: overlayBuffer
      },
      meta: {
        outputKey: "overlay",
        hidden: true,
        mode: params.mode,
        contentHash: hashBuffer(overlayBuffer)
      }
    },
    {
      outputId: "meta",
      kind: "json" as const,
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer({ ...configPayload, kind: "meta" }),
      meta: {
        outputKey: "meta",
        hidden: true,
        mode: params.mode
      }
    }
  ];
}

export async function executeSam2Node(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const boxesInput = ctx.inputs.descriptor?.[0] ?? ctx.inputs.boxes?.[0] ?? ctx.inputs.boxesConfig?.[0] ?? null;
  const imageInput = ctx.inputs.image?.[0] ?? null;
  const mode = resolveRequestedMode(ctx, Boolean(boxesInput));
  const warnings = [...(ctx.warnings ?? [])];

  if (mode === "guided" && !boxesInput) {
    throw new Error("Requires ObjectDetection descriptor JSON input.");
  }

  const nodeOutputRoot = path.join(
    getLocalStorageRoot(),
    "projects",
    ctx.projectSlug || ctx.projectId,
    "runs",
    ctx.runId,
    "nodes",
    ctx.nodeId,
    "sam2"
  );
  await fs.mkdir(nodeOutputRoot, { recursive: true });
  await fs.mkdir(path.join(nodeOutputRoot, "masks"), { recursive: true });
  await fs.mkdir(path.join(nodeOutputRoot, "masks_dino"), { recursive: true });
  await fs.mkdir(path.join(nodeOutputRoot, "overlays"), { recursive: true });

  const boxesMaterialized = boxesInput ? await materializeBoxesConfig(ctx, boxesInput, nodeOutputRoot) : null;
  const resolvedImagePath = await resolveImagePath({
    ctx,
    imageInput,
    boxesPayload: boxesMaterialized?.parsed ?? null,
    outputDir: nodeOutputRoot
  });
  const sourceImageArtifactId =
    imageInput?.artifactId ??
    (boxesInput && typeof boxesInput.meta.sourceImageArtifactId === "string"
      ? boxesInput.meta.sourceImageArtifactId
      : null);
  const sourceImageHash =
    imageInput?.hash ??
    (boxesInput && typeof boxesInput.meta.sourceImageHash === "string"
      ? boxesInput.meta.sourceImageHash
      : null);
  const sourceImageStorageKey =
    imageInput?.storageKey ??
    (boxesInput && typeof boxesInput.meta.sourceImageStorageKey === "string"
      ? boxesInput.meta.sourceImageStorageKey
      : null);

  const runMode = (process.env.SAM2_EXECUTION_MODE ?? "mock").toLowerCase();
  if (runMode === "real") {
    const command = await buildSam2Command({
      ctx,
      mode,
      resolvedImagePath,
      boxesConfigPath: boxesMaterialized?.commandConfigPath ?? boxesMaterialized?.boxesPath ?? null,
      outputDir: nodeOutputRoot
    });
    const commandLine = formatCommandLine(command.command, command.args);
    console.log(
      `[sam2] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=real cmd=${commandLine}`
    );

    try {
      await runProcess(command.command, command.args, getSam2RepoRoot());
      const outputs = await collectRealOutputs({
        mode,
        outputDir: nodeOutputRoot,
        command,
        resolvedImagePath,
        sourceImageArtifactId,
        sourceImageHash,
        sourceImageStorageKey,
        boxesPayload: boxesMaterialized?.parsed ?? null,
        warnings
      });
      return { mode, warnings, outputs };
    } catch (error) {
      const allowFallback = process.env.SAM2_ALLOW_MOCK_FALLBACK === "true";
      if (!allowFallback) {
        throw error;
      }
      warnings.push(
        `SegmentScene real execution failed. Using mock fallback. ${(error as Error).message}`
      );
    }
  } else {
    try {
      const mockCommand = await buildSam2Command({
        ctx,
        mode,
        resolvedImagePath,
        boxesConfigPath: boxesMaterialized?.commandConfigPath ?? boxesMaterialized?.boxesPath ?? null,
        outputDir: nodeOutputRoot
      });
      const mockCommandLine = formatCommandLine(mockCommand.command, mockCommand.args);
      console.log(
        `[sam2] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=mock would_run=${mockCommandLine}`
      );
    } catch (error) {
      console.log(
        `[sam2] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=mock unable_to_build_command=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const mockModeWarning =
    "SegmentScene mock mode active. Set SAM2_EXECUTION_MODE=real to run Python SegmentScene export.";
  if (!warnings.includes(mockModeWarning)) {
    warnings.push(mockModeWarning);
  }

  const mockOutputs = await buildMockOutputs({
    ctx,
    mode,
    imageInput,
    resolvedImagePath,
    sourceImageArtifactId,
    sourceImageHash,
    sourceImageStorageKey,
    boxesPayload: boxesMaterialized?.parsed ?? null,
    warnings
  });

  return {
    mode,
    warnings,
    outputs: mockOutputs
  };
}
