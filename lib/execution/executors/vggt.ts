import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { env } from "@/lib/env";
import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult, ResolvedArtifactInput } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";
import { runManagedProcess } from "@/lib/execution/process";
import { putObjectToStorage } from "@/lib/storage/s3";

interface VggtResultManifest {
  status?: string;
  model_id?: string;
  device?: string;
  media_type?: "image" | "video";
  input_path?: string;
  frame_count?: number;
  fps?: number;
  depth_preview_path?: string | null;
  depth_video_path?: string | null;
  camera_json_path?: string | null;
  sequence_manifest_path?: string | null;
  npz_path?: string | null;
  metadata_path?: string | null;
}

interface VggtSequenceManifest {
  media_type: "image" | "video";
  frame_count: number;
  fps: number;
  frames: Array<{
    index: number;
    frame_name: string;
    depth_preview_path: string;
    raw_depth_path: string;
    source_frame_index?: number;
    timestamp_sec?: number;
  }>;
}

interface UploadedVggtSequenceManifest {
  media_type: "image" | "video";
  frame_count: number;
  fps: number;
  frames: Array<{
    index: number;
    frame_name: string;
    source_frame_index: number;
    timestamp_sec: number;
    depth_storage_key: string;
    raw_depth_storage_key: string;
  }>;
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function getLocalStorageRoot() {
  return env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), ".local-storage");
}

function getVggtRepoRoot() {
  return env.VGGT_REPO_ROOT || "/ml_storage/ML_Models_git/vggt";
}

function getVggtPython() {
  return env.VGGT_PYTHON || path.join(getVggtRepoRoot(), ".venv", "bin", "python");
}

function inferInputExtension(input: ResolvedArtifactInput) {
  const loweredStorage = input.storageKey.toLowerCase();
  if (loweredStorage.endsWith(".mp4")) return "mp4";
  if (input.mimeType.includes("png")) return "png";
  if (input.mimeType.includes("webp")) return "webp";
  if (input.mimeType.includes("jpeg") || input.mimeType.includes("jpg")) return "jpg";
  return loweredStorage.split(".").pop() || "bin";
}

function resolveMimeType(filePath: string) {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".mp4")) return "video/mp4";
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".json")) return "application/json";
  if (lowered.endsWith(".npy")) return "application/octet-stream";
  return "application/octet-stream";
}

async function runProcess(command: string, args: string[], cwd: string, isCancellationRequested?: () => Promise<boolean>) {
  return runManagedProcess({
    command,
    args,
    cwd,
    label: "VGGT process",
    timeoutMs: env.VGGT_TIMEOUT_MS,
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

function resolveVideoFpsParam(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return String(numeric);
  return "1.0";
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
    "vggt",
    "sequence",
    params.bucketName,
    fileName
  ].join("/");

  await putObjectToStorage({
    key,
    body: buffer,
    contentType: resolveMimeType(params.localPath)
  });
  return key;
}

async function rewriteSequenceManifest(params: {
  ctx: NodeExecutionContext;
  outputDir: string;
  manifest: VggtSequenceManifest;
}): Promise<UploadedVggtSequenceManifest> {
  const rewrittenFrames = await Promise.all(
    params.manifest.frames.map(async (frame) => {
      const previewLocalPath = path.join(params.outputDir, frame.depth_preview_path);
      const rawDepthLocalPath = path.join(params.outputDir, frame.raw_depth_path);

      return {
        index: frame.index,
        frame_name: frame.frame_name,
        source_frame_index: frame.source_frame_index ?? frame.index,
        timestamp_sec: frame.timestamp_sec ?? 0,
        depth_storage_key: await uploadSequenceAsset({
          ctx: params.ctx,
          localPath: previewLocalPath,
          bucketName: "depth_preview"
        }),
        raw_depth_storage_key: await uploadSequenceAsset({
          ctx: params.ctx,
          localPath: rawDepthLocalPath,
          bucketName: "depth_raw"
        })
      };
    })
  );

  return {
    media_type: params.manifest.media_type,
    frame_count: params.manifest.frame_count,
    fps: params.manifest.fps,
    frames: rewrittenFrames
  };
}

function collectSequenceFrameStorageKeys(manifest: UploadedVggtSequenceManifest) {
  const keys = new Set<string>();
  for (const frame of manifest.frames) {
    keys.add(frame.depth_storage_key);
    keys.add(frame.raw_depth_storage_key);
  }
  return [...keys];
}

export async function executeVggtNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const imageInput = ctx.inputs.image?.[0] ?? null;
  const videoInput = ctx.inputs.video?.[0] ?? null;
  if (!imageInput && !videoInput) {
    throw new Error("VGGT requires an image or video input.");
  }
  if (imageInput && videoInput) {
    throw new Error("VGGT accepts either an image or video input, not both.");
  }

  const sourceInput = imageInput ?? videoInput;
  if (!sourceInput) {
    throw new Error("VGGT source input is missing.");
  }

  const device =
    typeof ctx.params.device === "string" && ["auto", "cuda", "cpu"].includes(ctx.params.device)
      ? ctx.params.device
      : "auto";
  const videoFps = resolveVideoFpsParam(ctx.params.videoFps);
  const maxFrames = resolveNumberParam(ctx.params.maxFrames, 32, 1);
  const saveNpz = resolveBooleanParam(ctx.params.saveNpz, false);

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
    "vggt"
  );
  await fs.mkdir(outputDir, { recursive: true });

  const inputPath = await materializeInput(
    ctx,
    sourceInput,
    outputDir,
    videoInput ? "video" : "image"
  );

  const wrapperPath = path.join(process.cwd(), "python_script", "vggt_infer.py");
  const command = getVggtPython();
  const args = [
    wrapperPath,
    "--repo-root",
    getVggtRepoRoot(),
    "--input",
    inputPath,
    "--output-dir",
    outputDir,
    "--device",
    device,
    "--video-fps",
    videoFps,
    "--max-frames",
    String(maxFrames)
  ];
  if (saveNpz) args.push("--save-npz");

  await runProcess(command, args, getVggtRepoRoot(), ctx.isCancellationRequested);

  const manifestPath = path.join(outputDir, "result_manifest.json");
  const manifest = await readJsonFile<VggtResultManifest>(manifestPath);
  if (!manifest.depth_preview_path) {
    throw new Error("VGGT manifest is missing depth_preview_path.");
  }

  const sequenceManifest = manifest.sequence_manifest_path
    ? await readJsonFile<VggtSequenceManifest>(path.join(outputDir, manifest.sequence_manifest_path))
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
      mimeType: resolveMimeType(depthPreviewPath),
      extension: path.extname(depthPreviewPath).replace(".", "") || "png",
      buffer: depthBuffer,
      preview: {
        extension: path.extname(depthPreviewPath).replace(".", "") || "png",
        mimeType: resolveMimeType(depthPreviewPath),
        buffer: depthBuffer
      },
      meta: {
        outputKey: "depth",
        artifactType: "DepthMap",
        semantic: "depth",
        mediaType: manifest.media_type ?? (videoInput ? "video" : "image"),
        frameCount: manifest.frame_count ?? 1,
        fps: manifest.fps ?? 0,
        modelId: manifest.model_id ?? "facebook/VGGT-1B",
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
        modelId: manifest.model_id ?? "facebook/VGGT-1B",
        contentHash: hashBuffer(depthVideoBuffer)
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
        frameCount: manifest.frame_count ?? 1,
        modelId: manifest.model_id ?? "facebook/VGGT-1B"
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
    saveNpz
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
      mode: manifest.media_type ?? (videoInput ? "video" : "image")
    }
  });

  return {
    mode: manifest.media_type ?? (videoInput ? "video" : "image"),
    outputs
  };
}
