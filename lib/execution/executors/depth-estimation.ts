import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { env } from "@/lib/env";
import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult, ResolvedArtifactInput } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";
import { runManagedProcess } from "@/lib/execution/process";
import { putObjectToStorage } from "@/lib/storage/s3";

interface DepthResultManifest {
  status?: string;
  model_variant?: string;
  model_id?: string;
  device?: string;
  media_type?: "image" | "video";
  frame_count?: number;
  fps?: number;
  is_metric?: number;
  has_pose?: boolean;
  has_intrinsics?: boolean;
  has_confidence?: boolean;
  has_sky?: boolean;
  depth_preview_path?: string | null;
  depth_video_path?: string | null;
  confidence_preview_path?: string | null;
  sky_preview_path?: string | null;
  camera_json_path?: string | null;
  sequence_manifest_path?: string | null;
  npz_path?: string | null;
}

interface DepthSequenceManifest {
  media_type: "image" | "video";
  frame_count: number;
  fps: number;
  frames: Array<{
    index: number;
    depth_path: string;
    confidence_path?: string;
    sky_path?: string;
    source_frame_index?: number;
    timestamp_sec?: number;
  }>;
}

interface UploadedDepthSequenceManifest {
  media_type: "image" | "video";
  frame_count: number;
  fps: number;
  frames: Array<{
    index: number;
    source_frame_index: number;
    timestamp_sec: number;
    depth_storage_key: string;
    confidence_storage_key?: string;
    sky_storage_key?: string;
  }>;
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function getLocalStorageRoot() {
  return env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), ".local-storage");
}

function getDepthAnythingRepoRoot() {
  return env.DEPTH_ANYTHING3_REPO_ROOT || "/ml_storage/ML_Models_git/Depth-Anything-3";
}

function getDepthAnythingPython() {
  return env.DEPTH_ANYTHING3_PYTHON || path.join(getDepthAnythingRepoRoot(), ".venv", "bin", "python");
}

function inferInputExtension(input: ResolvedArtifactInput) {
  const loweredStorage = input.storageKey.toLowerCase();
  if (loweredStorage.endsWith(".mp4")) return "mp4";
  if (input.mimeType.includes("png")) return "png";
  if (input.mimeType.includes("webp")) return "webp";
  if (input.mimeType.includes("jpeg") || input.mimeType.includes("jpg")) return "jpg";
  return loweredStorage.split(".").pop() || "bin";
}

function resolveDepthPreviewMime(filePath: string) {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".mp4")) return "video/mp4";
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function runProcess(command: string, args: string[], cwd: string, isCancellationRequested?: () => Promise<boolean>) {
  return runManagedProcess({
    command,
    args,
    cwd,
    label: "Depth estimation process",
    timeoutMs: env.DEPTH_ANYTHING3_TIMEOUT_MS,
    isCancellationRequested
  });
}

async function readJsonFile<T>(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function resolveBooleanParam(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function resolveNumberParam(value: unknown, fallback: number, min: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

async function materializeInput(
  ctx: NodeExecutionContext,
  input: ResolvedArtifactInput,
  outputDir: string,
  outputBasename: "image" | "video"
) {
  const extension = inferInputExtension(input);
  const filePath = path.join(outputDir, `${outputBasename}.${extension}`);
  const buffer = await ctx.loadInputBuffer(input);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function uploadSequenceAsset(params: {
  ctx: NodeExecutionContext;
  localPath: string;
  bucketName: string;
}) {
  const buffer = await fs.readFile(params.localPath);
  const fileName = path.basename(params.localPath);
  const key = [
    "projects",
    params.ctx.projectSlug || params.ctx.projectId,
    "runs",
    params.ctx.runFolderLabel ?? params.ctx.runId,
    "steps",
    params.ctx.stepFolderLabel ?? params.ctx.nodeId,
    `attempt-${String(params.ctx.attempt ?? 1).padStart(2, "0")}`,
    "depth_estimation",
    "sequence",
    params.bucketName,
    fileName
  ].join("/");

  await putObjectToStorage({
    key,
    body: buffer,
    contentType: resolveDepthPreviewMime(params.localPath)
  });
  return key;
}

async function rewriteSequenceManifest(params: {
  ctx: NodeExecutionContext;
  outputDir: string;
  manifest: DepthSequenceManifest;
}): Promise<UploadedDepthSequenceManifest> {
  const rewrittenFrames = await Promise.all(
    params.manifest.frames.map(async (frame) => {
      const nextFrame: UploadedDepthSequenceManifest["frames"][number] = {
        index: frame.index,
        source_frame_index: frame.source_frame_index ?? frame.index,
        timestamp_sec: frame.timestamp_sec ?? 0,
        depth_storage_key: ""
      };

      const depthLocal = path.join(params.outputDir, frame.depth_path);
      nextFrame.depth_storage_key = await uploadSequenceAsset({
        ctx: params.ctx,
        localPath: depthLocal,
        bucketName: "depth"
      });

      if (frame.confidence_path) {
        nextFrame.confidence_storage_key = await uploadSequenceAsset({
          ctx: params.ctx,
          localPath: path.join(params.outputDir, frame.confidence_path),
          bucketName: "confidence"
        });
      }

      if (frame.sky_path) {
        nextFrame.sky_storage_key = await uploadSequenceAsset({
          ctx: params.ctx,
          localPath: path.join(params.outputDir, frame.sky_path),
          bucketName: "sky"
        });
      }

      return nextFrame;
    })
  );

  return {
    media_type: params.manifest.media_type,
    frame_count: params.manifest.frame_count,
    fps: params.manifest.fps,
    frames: rewrittenFrames
  };
}

function collectSequenceFrameStorageKeys(manifest: UploadedDepthSequenceManifest) {
  const keys = new Set<string>();
  for (const frame of manifest.frames) {
    keys.add(frame.depth_storage_key);
    if (typeof frame.confidence_storage_key === "string" && frame.confidence_storage_key.length > 0) {
      keys.add(frame.confidence_storage_key);
    }
    if (typeof frame.sky_storage_key === "string" && frame.sky_storage_key.length > 0) {
      keys.add(frame.sky_storage_key);
    }
  }
  return [...keys];
}

export async function executeDepthEstimationNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const imageInput = ctx.inputs.image?.[0] ?? null;
  const videoInput = ctx.inputs.video?.[0] ?? null;
  if (!imageInput && !videoInput) {
    throw new Error("Depth Estimation requires an image or video input.");
  }
  if (imageInput && videoInput) {
    throw new Error("Depth Estimation accepts either image or video input, not both.");
  }

  const sourceInput = imageInput ?? videoInput;
  if (!sourceInput) {
    throw new Error("Depth Estimation source input is missing.");
  }

  const modelVariant =
    typeof ctx.params.modelVariant === "string" && ["da3-base", "da3metric-large"].includes(ctx.params.modelVariant)
      ? ctx.params.modelVariant
      : "da3-base";
  const device =
    typeof ctx.params.device === "string" && ["auto", "cuda", "cpu"].includes(ctx.params.device)
      ? ctx.params.device
      : "auto";
  const exportConfidence = resolveBooleanParam(ctx.params.exportConfidence, true);
  const exportSky = resolveBooleanParam(ctx.params.exportSky, true);
  const saveNpz = resolveBooleanParam(ctx.params.saveNpz, false);
  const useRayPose = resolveBooleanParam(ctx.params.useRayPose, false);
  const refViewStrategy =
    typeof ctx.params.refViewStrategy === "string" && ctx.params.refViewStrategy.trim().length > 0
      ? ctx.params.refViewStrategy.trim()
      : "saddle_balanced";
  const frameStride = resolveNumberParam(ctx.params.frameStride, 1, 1);
  const maxFrames = resolveNumberParam(ctx.params.maxFrames, 32, 1);
  const resizeLongEdge = resolveNumberParam(ctx.params.resizeLongEdge, 0, 0);

  const runFolderSegment = ctx.runFolderLabel ?? ctx.runId;
  const stepFolderSegment = ctx.stepFolderLabel ?? ctx.nodeId;
  const attemptSegment = `attempt-${String(ctx.attempt ?? 1).padStart(2, "0")}`;
  const outputDir = path.join(
    getLocalStorageRoot(),
    "projects",
    ctx.projectSlug || ctx.projectId,
    "runs",
    runFolderSegment,
    "steps",
    stepFolderSegment,
    attemptSegment,
    "depth_anything3"
  );
  await fs.mkdir(outputDir, { recursive: true });

  const inputPath = await materializeInput(
    ctx,
    sourceInput,
    outputDir,
    videoInput ? "video" : "image"
  );

  const warnings = [...(ctx.warnings ?? [])];
  if (modelVariant === "da3metric-large" && useRayPose) {
    warnings.push("da3metric-large does not estimate pose/intrinsics; ray pose is ignored by the model.");
  }

  const wrapperPath = path.join(process.cwd(), "python_script", "depth_anything3_infer.py");
  const command = getDepthAnythingPython();
  const args = [
    wrapperPath,
    "--repo-root",
    getDepthAnythingRepoRoot(),
    "--input",
    inputPath,
    "--output-dir",
    outputDir,
    "--model-variant",
    modelVariant,
    "--device",
    device,
    "--ref-view-strategy",
    refViewStrategy,
    "--frame-stride",
    String(frameStride),
    "--max-frames",
    String(maxFrames),
    "--resize-long-edge",
    String(resizeLongEdge)
  ];
  if (exportConfidence) args.push("--export-confidence");
  if (exportSky) args.push("--export-sky");
  if (saveNpz) args.push("--save-npz");
  if (useRayPose) args.push("--use-ray-pose");

  await runProcess(command, args, getDepthAnythingRepoRoot(), ctx.isCancellationRequested);

  const manifestPath = path.join(outputDir, "result_manifest.json");
  const manifest = await readJsonFile<DepthResultManifest>(manifestPath);

  if (!manifest.depth_preview_path) {
    throw new Error("Depth estimation manifest is missing depth_preview_path.");
  }

  const sequenceManifest = manifest.sequence_manifest_path
    ? await readJsonFile<DepthSequenceManifest>(path.join(outputDir, manifest.sequence_manifest_path))
    : null;
  const uploadedSequenceManifest = sequenceManifest
    ? await rewriteSequenceManifest({ ctx, outputDir, manifest: sequenceManifest })
    : null;

  const depthPreviewPath = path.join(outputDir, manifest.depth_preview_path);
  const depthBuffer = await fs.readFile(depthPreviewPath);

  const outputs: ExecutorOutputArtifact[] = [
    {
      outputId: "depth",
      kind: "image",
      artifactType: "DepthMap",
      mimeType: resolveDepthPreviewMime(depthPreviewPath),
      extension: path.extname(depthPreviewPath).replace(".", "") || "png",
      buffer: depthBuffer,
      preview: {
        extension: path.extname(depthPreviewPath).replace(".", "") || "png",
        mimeType: resolveDepthPreviewMime(depthPreviewPath),
        buffer: depthBuffer
      },
      meta: {
        outputKey: "depth",
        artifactType: "DepthMap",
        semantic: "depth",
        mediaType: manifest.media_type ?? (videoInput ? "video" : "image"),
        frameCount: manifest.frame_count ?? 1,
        isMetric: manifest.is_metric ?? 0,
        modelVariant,
        contentHash: hashBuffer(depthBuffer)
      }
    }
  ];

  if (manifest.depth_video_path) {
    const depthVideoPath = path.join(outputDir, manifest.depth_video_path);
    const depthVideoBuffer = await fs.readFile(depthVideoPath);
    outputs.push({
      outputId: "depthVideo",
      kind: "json",
      artifactType: "Video",
      mimeType: "video/mp4",
      extension: "mp4",
      buffer: depthVideoBuffer,
      meta: {
        outputKey: "depthVideo",
        artifactType: "Video",
        semantic: "depth_video",
        mediaType: manifest.media_type ?? "video",
        frameCount: manifest.frame_count ?? 1,
        fps: manifest.fps ?? 0,
        modelVariant,
        contentHash: hashBuffer(depthVideoBuffer)
      }
    });
  }

  if (manifest.confidence_preview_path) {
    const confidencePath = path.join(outputDir, manifest.confidence_preview_path);
    const confidenceBuffer = await fs.readFile(confidencePath);
    outputs.push({
      outputId: "confidence",
      kind: "image",
      artifactType: "Image",
      mimeType: resolveDepthPreviewMime(confidencePath),
      extension: path.extname(confidencePath).replace(".", "") || "png",
      hidden: true,
      buffer: confidenceBuffer,
      preview: {
        extension: path.extname(confidencePath).replace(".", "") || "png",
        mimeType: resolveDepthPreviewMime(confidencePath),
        buffer: confidenceBuffer
      },
      meta: {
        outputKey: "confidence",
        hidden: true,
        artifactType: "Image",
        modelVariant
      }
    });
  }

  if (manifest.sky_preview_path) {
    const skyPath = path.join(outputDir, manifest.sky_preview_path);
    const skyBuffer = await fs.readFile(skyPath);
    outputs.push({
      outputId: "sky",
      kind: "image",
      artifactType: "Image",
      mimeType: resolveDepthPreviewMime(skyPath),
      extension: path.extname(skyPath).replace(".", "") || "png",
      hidden: true,
      buffer: skyBuffer,
      preview: {
        extension: path.extname(skyPath).replace(".", "") || "png",
        mimeType: resolveDepthPreviewMime(skyPath),
        buffer: skyBuffer
      },
      meta: {
        outputKey: "sky",
        hidden: true,
        artifactType: "Image",
        modelVariant
      }
    });
  }

  if (manifest.camera_json_path) {
    const cameraPath = path.join(outputDir, manifest.camera_json_path);
    const cameraBuffer = await fs.readFile(cameraPath);
    outputs.push({
      outputId: "camera",
      kind: "json",
      artifactType: "Descriptor",
      mimeType: "application/json",
      extension: "json",
      buffer: cameraBuffer,
      meta: {
        outputKey: "camera",
        artifactType: "Descriptor",
        modelVariant,
        isMetric: manifest.is_metric ?? 0
      }
    });
  }

  if (uploadedSequenceManifest) {
    const sequenceFrameStorageKeys = collectSequenceFrameStorageKeys(uploadedSequenceManifest);
    outputs.push({
      outputId: "sequence",
      kind: "json",
      artifactType: "JsonData",
      mimeType: "application/json",
      extension: "json",
      buffer: createJsonBuffer(uploadedSequenceManifest as unknown as Record<string, unknown>),
      meta: {
        outputKey: "sequence",
        artifactType: "JsonData",
        semantic: "image_sequence",
        mediaType: uploadedSequenceManifest.media_type,
        frameCount: uploadedSequenceManifest.frame_count,
        fps: uploadedSequenceManifest.fps,
        sequenceFrameStorageKeys
      }
    });
  }

  const metaPayload = {
    ...manifest,
    inputArtifactId: sourceInput.artifactId,
    inputMimeType: sourceInput.mimeType,
    warnings
  };
  outputs.push({
    outputId: "meta",
    kind: "json",
    artifactType: "JsonData",
    mimeType: "application/json",
    extension: "json",
    hidden: true,
    buffer: createJsonBuffer(metaPayload as Record<string, unknown>),
    meta: {
      outputKey: "meta",
      artifactType: "JsonData",
      hidden: true,
      mode: manifest.media_type,
      warnings
    }
  });

  return {
    mode: manifest.media_type,
    warnings,
    outputs
  };
}
