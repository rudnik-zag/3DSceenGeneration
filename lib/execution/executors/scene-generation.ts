import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult, ResolvedArtifactInput } from "@/lib/execution/contracts";
import { createJsonBuffer, createMinimalGlbBuffer, createPointCloudPlyBuffer } from "@/lib/execution/mock-assets";
import { getDefaultSam3dConfig, resolveSam3dConfigName } from "@/lib/sam3d/configs";
import { putObjectToStorage } from "@/lib/storage/s3";

type SceneMode = "mesh" | "gaussian";

interface SceneCommand {
  command: string;
  args: string[];
  cwd: string;
  outputDir: string;
  mode: SceneMode;
  configName: string;
  settings: {
    maxObjects: number | null;
    enableMesh: boolean;
    exportMeshGlb: boolean;
    enableMeshScene: boolean;
    meshPostprocess: boolean;
    textureBaking: boolean;
    decodeMesh: boolean;
    stage1Steps: number | null;
    stage2Steps: number | null;
    fallbackStage1Steps: number;
    fallbackStage2Steps: number;
    autocast: boolean;
    autocastPreferBf16: boolean;
    storeOnCpu: boolean;
    runAllMasksInOneProcess: boolean;
  };
}

const SCENE_DEFAULT_SETTINGS = {
  maxObjects: null as number | null,
  enableMesh: true,
  exportMeshGlb: true,
  enableMeshScene: true,
  meshPostprocess: false,
  textureBaking: false,
  decodeMesh: true,
  stage1Steps: null as number | null,
  stage2Steps: null as number | null,
  fallbackStage1Steps: 15,
  fallbackStage2Steps: 15,
  autocast: false,
  autocastPreferBf16: false,
  storeOnCpu: true,
  runAllMasksInOneProcess: true
};

interface SceneManifest {
  mode?: string;
  config?: string;
  scene_path?: string;
  masks_count?: number;
  image_path?: string;
  masks_dir?: string;
  input_paths?: {
    image?: string;
    mask?: string;
    pipeline_config?: string;
  };
  output_paths?: {
    output_dir?: string;
    scene?: string;
    mesh_parts_dir?: string;
    mesh_objects_dir?: string;
  };
  run_config?: Record<string, unknown>;
  objects?: Array<{
    index: number;
    mask_name: string;
    mask_path: string;
    transformed_object_path: string;
    mesh_part_path?: string;
  }>;
  created_at?: string;
}

interface SceneExecutionConfigMetadata {
  schemaVersion: "1.0";
  createdAt: string;
  run: {
    projectId: string;
    projectSlug: string;
    runId: string;
    nodeId: string;
    nodeType: string;
  };
  execution: {
    requestedMode: SceneMode;
    executionMode: "real" | "mock";
    configName: string;
    runAllMasksInOneProcess: boolean;
    maxObjects: number | null;
  };
  reconstruction: {
    policy: "one_object_per_mask_file";
    masksDir: string;
    discoveredMaskCount: number | null;
    expectedObjectsToReconstruct: number | null;
    maskFiles: string[];
  };
  inputOrigins: {
    selectedConfigInputPort: string | null;
    resolvedImageSource:
      | {
          kind: "input_port";
          port: string;
          sourceNodeId: string;
          sourceOutputId: string;
          artifactId: string;
          storageKey: string;
        }
      | {
          kind: "config_json";
          field: "sourceImagePath";
          path: string;
        }
      | null;
  };
  inputPorts: Record<
    string,
    Array<{
      artifactId: string;
      sourceNodeId: string;
      sourceOutputId: string;
      artifactKind: string;
      artifactType: string;
      mimeType: string;
      storageKey: string;
      byteSize: number;
      hash: string;
    }>
  >;
  upstreamNodeIds: string[];
  configPreview: {
    hasSourceImagePath: boolean;
    sourceImagePath: string | null;
    overlayPath: string | null;
    payloadKeys: string[];
  };
}

function normalizeProcessLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function truncateLine(value: string, maxChars = 260) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function extractProcessWarnings(stdout: string, stderr: string) {
  const warningTokens = ["[warn]", "warning", "skip transformed export", "skipping"];
  const lines = [...normalizeProcessLines(stdout), ...normalizeProcessLines(stderr)];
  const collected: string[] = [];

  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (!warningTokens.some((token) => lowered.includes(token))) continue;
    const normalized = truncateLine(line);
    if (!collected.includes(normalized)) {
      collected.push(normalized);
    }
  }
  return collected;
}

function getProcessTail(text: string, maxLines = 120, maxChars = 12000) {
  const lines = normalizeProcessLines(text);
  const sliced = lines.slice(-maxLines).join("\n");
  if (sliced.length <= maxChars) return sliced;
  return sliced.slice(sliced.length - maxChars);
}

function pushWarningUnique(target: string[], message: string) {
  const normalized = message.trim();
  if (!normalized) return;
  if (target.includes(normalized)) return;
  target.push(normalized);
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function quoteShellArg(value: string) {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/:.=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function formatCommandLine(command: string, args: string[]) {
  return [quoteShellArg(command), ...args.map((arg) => quoteShellArg(arg))].join(" ");
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getLocalStorageRoot() {
  return process.env.LOCAL_STORAGE_ROOT || path.join(process.cwd(), ".local-storage");
}

function getSam3dRepoRoot() {
  return process.env.SAM3D_REPO_ROOT || path.join(process.cwd(), "models", "sam-3d-objects");
}

function resolveScriptPath(repoRoot: string) {
  const configured = process.env.SAM3D_WEB_SCRIPT?.trim();
  if (!configured) return path.join(repoRoot, "inference_for_webapp_per_object.py");
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

function resolveGaussianScriptPath(repoRoot: string) {
  const configured = process.env.SAM3D_WEB_GAUSSIAN_SCRIPT?.trim();
  if (!configured) return path.join(repoRoot, "inference_for_webapp_gaussian.py");
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

function resolveSingleMaskScriptPath(repoRoot: string) {
  const configured = process.env.SAM3D_WEB_SINGLE_MASK_SCRIPT?.trim();
  if (!configured) return path.join(repoRoot, "inference_for_webapp_per_object_single_mask.py");
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

function extensionFromMime(mimeType: string) {
  const lowered = mimeType.toLowerCase();
  if (lowered.includes("png")) return "png";
  if (lowered.includes("webp")) return "webp";
  if (lowered.includes("svg")) return "svg";
  return "jpg";
}

function asPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded <= 0) return null;
  return rounded;
}

function resolveSceneSettings(ctx: NodeExecutionContext) {
  return {
    ...SCENE_DEFAULT_SETTINGS,
    maxObjects: asPositiveInt(ctx.params.maxObjects),
    runAllMasksInOneProcess: ctx.params.runAllMasksInOneProcess !== false
  };
}

async function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env };
    if (!env.PYTORCH_CUDA_ALLOC_CONF) {
      env.PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True";
    }
    const child = spawn(command, args, { cwd, env });
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
            `SceneGeneration process failed (exit=${code})\n` +
              `cmd: ${command} ${args.join(" ")}\n` +
              `stderr: ${stderr.slice(-10000)}`
          )
        );
      }
    });
  });
}

function isCudaOomError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lowered = message.toLowerCase();
  return lowered.includes("cuda out of memory") || lowered.includes("outofmemoryerror");
}

async function materializeImageInput(
  ctx: NodeExecutionContext,
  imageInput: ResolvedArtifactInput,
  outputDir: string
) {
  const ext = extensionFromMime(imageInput.mimeType);
  const imagePath = path.join(outputDir, `input_image.${ext}`);
  const imageBuffer = await ctx.loadInputBuffer(imageInput);
  await fs.writeFile(imagePath, imageBuffer);
  return { imagePath, imageBuffer, extension: ext };
}

async function parseSam2ConfigInput(ctx: NodeExecutionContext, input: ResolvedArtifactInput | null) {
  if (!input) {
    throw new Error("SceneGeneration requires SegmentScene config JSON input.");
  }
  const raw = await ctx.loadInputBuffer(input);
  const parsed = safeJsonParse<Record<string, unknown>>(raw.toString("utf8"));
  if (!parsed) {
    throw new Error("SceneGeneration config input is not valid JSON.");
  }

  const masksDir =
    typeof parsed.masksDir === "string"
      ? parsed.masksDir
      : typeof parsed.masks_dir === "string"
        ? parsed.masks_dir
        : typeof parsed.outputDir === "string"
          ? parsed.outputDir
          : null;
  if (!masksDir) {
    throw new Error("SceneGeneration config JSON is missing masksDir path.");
  }

  try {
    await fs.access(masksDir);
  } catch {
    throw new Error(`SceneGeneration masks directory does not exist: ${masksDir}`);
  }

  const sourceImagePath =
    typeof parsed.sourceImagePath === "string"
      ? parsed.sourceImagePath
      : typeof parsed.source_image_path === "string"
        ? parsed.source_image_path
        : typeof parsed.imagePath === "string"
          ? parsed.imagePath
          : typeof parsed.image_path === "string"
            ? parsed.image_path
            : null;

  const overlayPath =
    typeof parsed.overlayPath === "string"
      ? parsed.overlayPath
      : typeof parsed.overlay_path === "string"
        ? parsed.overlay_path
        : null;

  return {
    masksDir,
    sourceImagePath,
    overlayPath,
    payload: parsed,
    raw
  };
}

function resolveMode(ctx: NodeExecutionContext): SceneMode {
  const format = typeof ctx.params.format === "string" ? ctx.params.format : "mesh_glb";
  return format === "point_ply" ? "gaussian" : "mesh";
}

function resolveOutputKind(mode: SceneMode) {
  if (mode === "gaussian") {
    return {
      kind: "point_ply" as const,
      mimeType: "application/octet-stream",
      extension: "ply"
    };
  }
  return {
    kind: "mesh_glb" as const,
    mimeType: "model/gltf-binary",
    extension: "glb"
  };
}

function buildPythonInvocation(scriptPath: string) {
  const useConda = (process.env.SAM3D_USE_CONDA ?? "true").toLowerCase() !== "false";
  if (useConda) {
    const command = process.env.SAM3D_CONDA_COMMAND?.trim() || "conda";
    const envName = process.env.SAM3D_CONDA_ENV?.trim() || "sam3d-objects";
    return {
      command,
      args: ["run", "-n", envName, "python", scriptPath]
    };
  }
  const pythonCommand = process.env.SAM3D_PYTHON_COMMAND?.trim() || "python";
  return {
    command: pythonCommand,
    args: [scriptPath]
  };
}

async function buildSceneCommand(params: {
  ctx: NodeExecutionContext;
  mode: SceneMode;
  imagePath: string;
  masksDir: string;
  outputDir: string;
}) {
  const repoRoot = getSam3dRepoRoot();
  const scriptPath = params.mode === "gaussian" ? resolveGaussianScriptPath(repoRoot) : resolveScriptPath(repoRoot);
  const base = buildPythonInvocation(scriptPath);
  const configName = await resolveSam3dConfigName(typeof params.ctx.params.config === "string" ? params.ctx.params.config : getDefaultSam3dConfig());
  const settings = resolveSceneSettings(params.ctx);

  const args = [
    ...base.args,
    "--mode",
    params.mode,
    "--image",
    params.imagePath,
    "--masks_dir",
    params.masksDir,
    "--output",
    params.outputDir,
    "--config",
    configName
  ];

  return {
    command: base.command,
    args,
    cwd: repoRoot,
    outputDir: params.outputDir,
    mode: params.mode,
    configName,
    settings
  } satisfies SceneCommand;
}

async function buildSingleMaskSceneCommand(params: {
  ctx: NodeExecutionContext;
  mode: SceneMode;
  imagePath: string;
  maskPath: string;
  outputDir: string;
  maskIndex: number;
}) {
  const repoRoot = getSam3dRepoRoot();
  const scriptPath = resolveSingleMaskScriptPath(repoRoot);
  const base = buildPythonInvocation(scriptPath);
  const configName = await resolveSam3dConfigName(
    typeof params.ctx.params.config === "string" ? params.ctx.params.config : getDefaultSam3dConfig()
  );
  const settings = resolveSceneSettings(params.ctx);

  const args = [
    ...base.args,
    "--mode",
    params.mode,
    "--image",
    params.imagePath,
    "--mask",
    params.maskPath,
    "--output",
    params.outputDir,
    "--config",
    configName,
    "--mask-index",
    String(params.maskIndex)
  ];

  return {
    command: base.command,
    args,
    cwd: repoRoot,
    outputDir: params.outputDir,
    mode: params.mode,
    configName,
    settings
  } satisfies SceneCommand;
}

async function loadManifest(outputDir: string, stdout: string): Promise<SceneManifest> {
  const manifestPath = path.join(outputDir, "result_manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = safeJsonParse<SceneManifest>(raw);
    if (parsed) return parsed;
  } catch {
    // Fallback to stdout parsing.
  }

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = safeJsonParse<SceneManifest>(lines[i]);
    if (parsed) return parsed;
  }
  return {};
}

async function countMaskFiles(masksDir: string) {
  try {
    const entries = await fs.readdir(masksDir);
    return entries.filter((name) => name.toLowerCase().endsWith(".png")).length;
  } catch {
    return null;
  }
}

async function listMaskFiles(masksDir: string) {
  try {
    const entries = await fs.readdir(masksDir);
    return entries
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function summarizeInputPorts(ctx: NodeExecutionContext) {
  const inputPorts: SceneExecutionConfigMetadata["inputPorts"] = {};
  const upstreamNodeIds = new Set<string>();

  for (const [port, values] of Object.entries(ctx.inputs)) {
    inputPorts[port] = values.map((entry) => {
      upstreamNodeIds.add(entry.nodeId);
      return {
        artifactId: entry.artifactId,
        sourceNodeId: entry.nodeId,
        sourceOutputId: entry.outputId,
        artifactKind: entry.kind,
        artifactType: entry.artifactType,
        mimeType: entry.mimeType,
        storageKey: entry.storageKey,
        byteSize: entry.byteSize,
        hash: entry.hash
      };
    });
  }

  return {
    inputPorts,
    upstreamNodeIds: [...upstreamNodeIds].sort((a, b) => a.localeCompare(b))
  };
}

async function collectRealOutputs(params: {
  ctx: NodeExecutionContext;
  mode: SceneMode;
  command: SceneCommand;
  processStdout: string;
  processStderr: string;
  warnings: string[];
  imagePath: string;
  masksDir: string;
}) {
  const manifest = await loadManifest(params.command.outputDir, params.processStdout);
  const processWarnings = extractProcessWarnings(params.processStdout, params.processStderr);
  for (const warning of processWarnings) {
    pushWarningUnique(params.warnings, warning);
  }

  const inputMaskCount = await countMaskFiles(params.masksDir);
  const outputMaskCount = typeof manifest.masks_count === "number" ? manifest.masks_count : null;
  if (
    typeof inputMaskCount === "number" &&
    typeof outputMaskCount === "number" &&
    outputMaskCount < inputMaskCount
  ) {
    pushWarningUnique(
      params.warnings,
      `SceneGeneration processed ${outputMaskCount}/${inputMaskCount} masks; one or more objects were skipped during mesh generation.`
    );
  }

  const expected = resolveOutputKind(params.mode);
  let scenePath = "";
  let sceneBuffer: Buffer;
  let meshObjectStorageKeys: string[] = [];
  if (params.mode === "gaussian") {
    const fallbackPath = path.join(params.command.outputDir, `scene.${expected.extension}`);
    scenePath = manifest.scene_path ?? fallbackPath;
    sceneBuffer = await fs.readFile(scenePath).catch((error) => {
      throw new Error(`SceneGeneration output not found at ${scenePath}: ${(error as Error).message}`);
    });
  } else {
    const meshObjectPathSet = new Set<string>();
    const resolveCandidateFile = async (candidate: string | null | undefined) => {
      if (!candidate || candidate.trim().length === 0) return null;
      const trimmed = candidate.trim();
      const candidates = path.isAbsolute(trimmed)
        ? [trimmed]
        : [path.resolve(params.command.outputDir, trimmed), path.resolve(process.cwd(), trimmed)];
      for (const resolved of candidates) {
        try {
          const stat = await fs.stat(resolved);
          if (stat.isFile() && resolved.toLowerCase().endsWith(".glb")) {
            return resolved;
          }
        } catch {
          // Try the next candidate.
        }
      }
      return null;
    };
    const resolveCandidateDir = async (candidate: string | null | undefined) => {
      if (!candidate || candidate.trim().length === 0) return null;
      const trimmed = candidate.trim();
      const candidates = path.isAbsolute(trimmed)
        ? [trimmed]
        : [path.resolve(params.command.outputDir, trimmed), path.resolve(process.cwd(), trimmed)];
      for (const resolved of candidates) {
        try {
          const stat = await fs.stat(resolved);
          if (stat.isDirectory()) {
            return resolved;
          }
        } catch {
          // Try the next candidate.
        }
      }
      return null;
    };

    if (Array.isArray(manifest.objects)) {
      for (const object of manifest.objects) {
        const resolved = await resolveCandidateFile(object?.transformed_object_path);
        if (resolved) meshObjectPathSet.add(path.resolve(resolved));
      }
    }

    const meshDirCandidates = [
      manifest.output_paths?.mesh_objects_dir,
      path.join(params.command.outputDir, "mesh_objects_transformed")
    ];
    for (const dirCandidate of meshDirCandidates) {
      const resolvedDir = await resolveCandidateDir(dirCandidate);
      if (!resolvedDir) continue;
      const files = await fs.readdir(resolvedDir);
      for (const fileName of files) {
        if (!fileName.toLowerCase().endsWith(".glb")) continue;
        meshObjectPathSet.add(path.resolve(path.join(resolvedDir, fileName)));
      }
    }

    const manifestScenePath = await resolveCandidateFile(manifest.scene_path);
    let primaryScenePath = manifestScenePath;
    const meshObjectPaths = [...meshObjectPathSet].sort((a, b) => a.localeCompare(b));
    if (!primaryScenePath && meshObjectPaths.length > 0) {
      primaryScenePath = meshObjectPaths[0];
    }
    if (!primaryScenePath) {
      throw new Error(
        `SceneGeneration mesh output missing transformed GLB files under ${path.join(
          params.command.outputDir,
          "mesh_objects_transformed"
        )}`
      );
    }

    scenePath = primaryScenePath;
    sceneBuffer = await fs.readFile(scenePath);

    const uploadCandidates = [...meshObjectPaths];
    if (!uploadCandidates.some((value) => path.resolve(value) === path.resolve(scenePath))) {
      uploadCandidates.unshift(scenePath);
    }

    const usedFileNames = new Set<string>();
    const uploadedKeys = new Set<string>();
    for (const localPath of uploadCandidates) {
      const fileNameBase = path.basename(localPath);
      let storageFileName = fileNameBase;
      let collisionIndex = 1;
      while (usedFileNames.has(storageFileName)) {
        const ext = path.extname(fileNameBase);
        const stem = ext ? fileNameBase.slice(0, -ext.length) : fileNameBase;
        storageFileName = `${stem}_${collisionIndex}${ext}`;
        collisionIndex += 1;
      }
      usedFileNames.add(storageFileName);

      const fileBuffer =
        path.resolve(localPath) === path.resolve(scenePath) ? sceneBuffer : await fs.readFile(localPath);
      const storageKey = [
        "projects",
        params.ctx.projectSlug || params.ctx.projectId,
        "runs",
        params.ctx.runId,
        "nodes",
        params.ctx.nodeId,
        "scene_generation",
        "outputs",
        "mesh_objects_transformed",
        storageFileName
      ].join("/");

      await putObjectToStorage({
        key: storageKey,
        body: fileBuffer,
        contentType: "model/gltf-binary"
      });
      uploadedKeys.add(storageKey);
    }
    meshObjectStorageKeys = [...uploadedKeys];
  }

  const metaPayload = {
    model: "sam3d-objects",
    mode: params.mode,
    config: params.command.configName,
    command: [params.command.command, ...params.command.args].join(" "),
    outputDir: params.command.outputDir,
    imagePath: params.imagePath,
    masksDir: params.masksDir,
    scenePath,
    sceneByteSize: sceneBuffer.length,
    meshObjectStorageKeys,
    masksCount: manifest.masks_count ?? null,
    inputMasksCount: inputMaskCount,
    settings: params.command.settings,
    warnings: params.warnings,
    processWarnings,
    processStdoutTail: getProcessTail(params.processStdout),
    processStderrTail: getProcessTail(params.processStderr),
    createdAt: new Date().toISOString()
  };

  const outputs: ExecutorOutputArtifact[] = [
    {
      outputId: "scene",
      kind: expected.kind,
      mimeType: expected.mimeType,
      extension: expected.extension,
      buffer: sceneBuffer,
      meta: {
        outputKey: "scene",
        mode: params.mode,
        config: params.command.configName,
        settings: params.command.settings,
        scenePath,
        meshObjectStorageKeys,
        contentHash: hashBuffer(sceneBuffer)
      }
    },
    {
      outputId: "meta",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer(metaPayload),
      meta: {
        outputKey: "meta",
        hidden: true,
        mode: params.mode
      }
    }
  ];

  return outputs;
}

async function executePerMaskReal(params: {
  ctx: NodeExecutionContext;
  mode: SceneMode;
  imagePath: string;
  masksDir: string;
  outputDir: string;
  warnings: string[];
}) {
  const maskEntries = await fs.readdir(params.masksDir);
  const sortedMasks = maskEntries
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort((a, b) => a.localeCompare(b));

  if (sortedMasks.length === 0) {
    throw new Error(`SceneGeneration found no masks in ${params.masksDir}`);
  }

  const settings = resolveSceneSettings(params.ctx);
  const maxObjects = settings.maxObjects;
  const masksToProcess = maxObjects ? sortedMasks.slice(0, maxObjects) : sortedMasks;
  const aggregateStdout: string[] = [];
  const aggregateStderr: string[] = [];
  await fs.rm(path.join(params.outputDir, "per_mask"), { recursive: true, force: true }).catch(() => {
    // legacy cleanup from older executor versions
  });
  const perMaskRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sam3d-per-mask-"));
  const meshPartsDir = path.join(params.outputDir, "mesh_parts");
  const meshObjectsDir = path.join(params.outputDir, "mesh_objects_transformed");
  await fs.mkdir(meshPartsDir, { recursive: true });
  await fs.mkdir(meshObjectsDir, { recursive: true });

  let keptCount = 0;
  let firstMeshObjectPath: string | null = null;
  let mergedRunConfig: Record<string, unknown> | null = null;
  const mergedObjects: NonNullable<SceneManifest["objects"]> = [];
  try {
    for (let index = 0; index < masksToProcess.length; index += 1) {
      const maskName = masksToProcess[index];
      const maskPath = path.join(params.masksDir, maskName);
      const maskOutDir = path.join(perMaskRoot, `mask_${index.toString().padStart(4, "0")}`);
      await fs.mkdir(maskOutDir, { recursive: true });

      const command = await buildSingleMaskSceneCommand({
        ctx: params.ctx,
        mode: params.mode,
        imagePath: params.imagePath,
        maskPath,
        outputDir: maskOutDir,
        maskIndex: index
      });
      const commandLine = formatCommandLine(command.command, command.args);
      console.log(
        `[scene-generation] runId=${params.ctx.runId} nodeId=${params.ctx.nodeId} mode=${params.mode} execution=real per-mask index=${index} cmd=${commandLine}`
      );

      try {
        const processResult = await runProcess(command.command, command.args, command.cwd);
        aggregateStdout.push(
          `[per-mask ${index}] ${processResult.stdout.trim()}`.trim()
        );
        if (processResult.stderr.trim().length > 0) {
          aggregateStderr.push(`[per-mask ${index}] ${processResult.stderr.trim()}`.trim());
        }

        const perMaskManifest = await loadManifest(maskOutDir, processResult.stdout);
        if (!mergedRunConfig && perMaskManifest.run_config && typeof perMaskManifest.run_config === "object") {
          mergedRunConfig = perMaskManifest.run_config;
        }
        const resolvedFromManifest =
          typeof perMaskManifest.objects?.[0]?.transformed_object_path === "string"
            ? perMaskManifest.objects[0].transformed_object_path
            : null;
        const manifestPathCandidates = resolvedFromManifest
          ? path.isAbsolute(resolvedFromManifest)
            ? [resolvedFromManifest]
            : [path.resolve(maskOutDir, resolvedFromManifest), path.resolve(process.cwd(), resolvedFromManifest)]
          : [];
        let perMaskObjectPath: string | null = null;
        for (const candidate of manifestPathCandidates) {
          try {
            const stat = await fs.stat(candidate);
            if (stat.isFile() && candidate.toLowerCase().endsWith(".glb")) {
              perMaskObjectPath = candidate;
              break;
            }
          } catch {
            // Try the next candidate.
          }
        }
        if (!perMaskObjectPath) {
          const perMaskObjectsDirCandidate =
            perMaskManifest.output_paths?.mesh_objects_dir ?? path.join(maskOutDir, "mesh_objects_transformed");
          const perMaskObjectsDir = path.isAbsolute(perMaskObjectsDirCandidate)
            ? perMaskObjectsDirCandidate
            : path.resolve(maskOutDir, perMaskObjectsDirCandidate);
          const files = await fs.readdir(perMaskObjectsDir);
          const glbFile = files
            .filter((name) => name.toLowerCase().endsWith(".glb"))
            .sort((a, b) => a.localeCompare(b))[0];
          if (!glbFile) {
            throw new Error(`No transformed object GLB found in ${perMaskObjectsDir}`);
          }
          perMaskObjectPath = path.join(perMaskObjectsDir, glbFile);
        }
        const copiedScenePath = path.join(
          meshObjectsDir,
          `object_${index.toString().padStart(3, "0")}_posed.glb`
        );
        await fs.copyFile(perMaskObjectPath, copiedScenePath);
        const sourceMeshPart = path.join(maskOutDir, "mesh_parts", `object_${index.toString().padStart(3, "0")}.glb`);
        const targetMeshPart = path.join(meshPartsDir, `object_${index.toString().padStart(3, "0")}.glb`);
        let meshPartPath: string | undefined;
        await fs.copyFile(sourceMeshPart, targetMeshPart).then(() => {
          meshPartPath = targetMeshPart;
        }).catch(() => {
          // Some runs may not produce per-mask mesh part files.
        });

        if (!firstMeshObjectPath) {
          firstMeshObjectPath = copiedScenePath;
        }
        mergedObjects.push({
          index,
          mask_name: maskName,
          mask_path: maskPath,
          transformed_object_path: copiedScenePath,
          mesh_part_path: meshPartPath
        });
        keptCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushWarningUnique(
          params.warnings,
          `Per-mask subprocess failed for ${maskName}: ${truncateLine(message, 360)}`
        );
        aggregateStderr.push(`[per-mask ${index}] ERROR: ${message}`);
      }
    }
  } finally {
    await fs.rm(perMaskRoot, { recursive: true, force: true }).catch(() => {
      // ignore temp cleanup failures
    });
  }

  if (!firstMeshObjectPath || keptCount === 0) {
    throw new Error("SceneGeneration per-mask mode produced no valid mesh objects.");
  }

  const composedManifest: SceneManifest = {
    mode: params.mode,
    config: typeof params.ctx.params.config === "string" ? params.ctx.params.config : getDefaultSam3dConfig(),
    scene_path: firstMeshObjectPath,
    masks_count: keptCount,
    image_path: params.imagePath,
    masks_dir: params.masksDir,
    output_paths: {
      output_dir: params.outputDir,
      scene: firstMeshObjectPath,
      mesh_parts_dir: meshPartsDir,
      mesh_objects_dir: meshObjectsDir
    },
    run_config: mergedRunConfig ?? undefined,
    objects: mergedObjects,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(params.outputDir, "result_manifest.json"),
    JSON.stringify(composedManifest, null, 2),
    "utf8"
  );

  return {
    stdout: aggregateStdout.join("\n"),
    stderr: aggregateStderr.join("\n")
  };
}

function buildMockOutputs(params: { mode: SceneMode; warnings: string[]; imagePath: string | null; masksDir: string | null }) {
  const expected = resolveOutputKind(params.mode);
  const sceneBuffer = params.mode === "gaussian" ? createPointCloudPlyBuffer() : createMinimalGlbBuffer();
  const metaPayload = {
    model: "sam3d-objects-mock",
    mode: params.mode,
    warnings: params.warnings,
    imagePath: params.imagePath,
    masksDir: params.masksDir,
    createdAt: new Date().toISOString()
  };

  return [
    {
      outputId: "scene",
      kind: expected.kind,
      mimeType: expected.mimeType,
      extension: expected.extension,
      buffer: sceneBuffer,
      meta: {
        outputKey: "scene",
        mode: params.mode,
        mock: true,
        contentHash: hashBuffer(sceneBuffer)
      }
    },
    {
      outputId: "meta",
      kind: "json" as const,
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: createJsonBuffer(metaPayload),
      meta: {
        outputKey: "meta",
        hidden: true,
        mode: params.mode
      }
    }
  ] satisfies ExecutorOutputArtifact[];
}

export async function executeSceneGenerationNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const imageInput = ctx.inputs.image?.[0] ?? null;
  const selectedConfigInputPort = ctx.inputs.config?.[0]
    ? "config"
    : ctx.inputs.masksDir?.[0]
      ? "masksDir"
      : ctx.inputs.maskDir?.[0]
        ? "maskDir"
        : null;
  const configInput = ctx.inputs.config?.[0] ?? ctx.inputs.masksDir?.[0] ?? ctx.inputs.maskDir?.[0] ?? null;
  const mode = resolveMode(ctx);
  const warnings = [...(ctx.warnings ?? [])];

  const nodeOutputRoot = path.join(
    getLocalStorageRoot(),
    "projects",
    ctx.projectSlug || ctx.projectId,
    "runs",
    ctx.runId,
    "nodes",
    ctx.nodeId,
    "scene_generation"
  );
  const outputDir = path.join(nodeOutputRoot, "outputs");
  await fs.mkdir(outputDir, { recursive: true });

  const config = await parseSam2ConfigInput(ctx, configInput);

  let resolvedImagePath: string | null = null;
  if (imageInput) {
    const materialized = await materializeImageInput(ctx, imageInput, nodeOutputRoot);
    resolvedImagePath = materialized.imagePath;
  } else if (typeof config.sourceImagePath === "string" && config.sourceImagePath.length > 0) {
    resolvedImagePath = config.sourceImagePath;
  }

  if (!resolvedImagePath) {
    throw new Error("SceneGeneration could not resolve input image path.");
  }

  const runModeRaw = (process.env.SAM3D_EXECUTION_MODE ?? "mock").toLowerCase();
  const runMode: "real" | "mock" = runModeRaw === "real" ? "real" : "mock";
  const settings = resolveSceneSettings(ctx);
  const configName = await resolveSam3dConfigName(
    typeof ctx.params.config === "string" ? ctx.params.config : getDefaultSam3dConfig()
  );
  const maskFiles = await listMaskFiles(config.masksDir);
  const discoveredMaskCount = maskFiles.length > 0 ? maskFiles.length : await countMaskFiles(config.masksDir);
  const expectedObjectsToReconstruct =
    typeof discoveredMaskCount === "number"
      ? settings.maxObjects ? Math.min(discoveredMaskCount, settings.maxObjects) : discoveredMaskCount
      : settings.maxObjects;
  const { inputPorts, upstreamNodeIds } = summarizeInputPorts(ctx);
  const resolvedImageSource: SceneExecutionConfigMetadata["inputOrigins"]["resolvedImageSource"] = imageInput
    ? {
        kind: "input_port",
        port: "image",
        sourceNodeId: imageInput.nodeId,
        sourceOutputId: imageInput.outputId,
        artifactId: imageInput.artifactId,
        storageKey: imageInput.storageKey
      }
    : config.sourceImagePath
      ? {
          kind: "config_json",
          field: "sourceImagePath",
          path: config.sourceImagePath
        }
      : null;
  const executionConfigPath = path.join(nodeOutputRoot, "scene_generation_execution_config.json");
  const executionConfig: SceneExecutionConfigMetadata = {
    schemaVersion: "1.0",
    createdAt: new Date().toISOString(),
    run: {
      projectId: ctx.projectId,
      projectSlug: ctx.projectSlug,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      nodeType: ctx.nodeType
    },
    execution: {
      requestedMode: mode,
      executionMode: runMode,
      configName,
      runAllMasksInOneProcess: settings.runAllMasksInOneProcess,
      maxObjects: settings.maxObjects
    },
    reconstruction: {
      policy: "one_object_per_mask_file",
      masksDir: config.masksDir,
      discoveredMaskCount,
      expectedObjectsToReconstruct,
      maskFiles
    },
    inputOrigins: {
      selectedConfigInputPort,
      resolvedImageSource
    },
    inputPorts,
    upstreamNodeIds,
    configPreview: {
      hasSourceImagePath: typeof config.sourceImagePath === "string" && config.sourceImagePath.length > 0,
      sourceImagePath: config.sourceImagePath,
      overlayPath: config.overlayPath,
      payloadKeys: Object.keys(config.payload ?? {}).sort((a, b) => a.localeCompare(b))
    }
  };
  await fs.writeFile(executionConfigPath, JSON.stringify(executionConfig, null, 2), "utf8");

  const usePerMaskSubprocess =
    settings.runAllMasksInOneProcess === false && mode === "mesh";
  if (runMode === "real") {
    try {
      const command = await buildSceneCommand({
        ctx,
        mode,
        imagePath: resolvedImagePath,
        masksDir: config.masksDir,
        outputDir
      });
      let processResult: { stdout: string; stderr: string };
      if (usePerMaskSubprocess) {
        console.log(
          `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=real strategy=per-mask-subprocess`
        );
        processResult = await executePerMaskReal({
          ctx,
          mode,
          imagePath: resolvedImagePath,
          masksDir: config.masksDir,
          outputDir,
          warnings
        });
      } else {
        const commandLine = formatCommandLine(command.command, command.args);
        console.log(
          `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=real strategy=single-process cmd=${commandLine}`
        );
        try {
          processResult = await runProcess(command.command, command.args, command.cwd);
        } catch (error) {
          if (mode !== "mesh" || !isCudaOomError(error)) {
            throw error;
          }

          pushWarningUnique(
            warnings,
            "SceneGeneration hit CUDA OOM in single-process mode; retrying with per-mask subprocess strategy."
          );
          console.log(
            `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=real strategy=single-process oom_detected=true retry=per-mask-subprocess`
          );
          processResult = await executePerMaskReal({
            ctx,
            mode,
            imagePath: resolvedImagePath,
            masksDir: config.masksDir,
            outputDir,
            warnings
          });
        }
      }
      const outputs = await collectRealOutputs({
        ctx,
        mode,
        command,
        processStdout: processResult.stdout,
        processStderr: processResult.stderr,
        warnings,
        imagePath: resolvedImagePath,
        masksDir: config.masksDir
      });
      return { mode, warnings, outputs };
    } catch (error) {
      const allowFallback = process.env.SAM3D_ALLOW_MOCK_FALLBACK === "true";
      if (!allowFallback) {
        throw error;
      }
      warnings.push(`SceneGeneration real execution failed. Using mock fallback. ${(error as Error).message}`);
    }
  } else {
    try {
      const mockCommand = await buildSceneCommand({
        ctx,
        mode,
        imagePath: resolvedImagePath,
        masksDir: config.masksDir,
        outputDir
      });
      const mockCommandLine = formatCommandLine(mockCommand.command, mockCommand.args);
      console.log(
        `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=mock strategy=${usePerMaskSubprocess ? "per-mask-subprocess" : "single-process"} would_run=${mockCommandLine}`
      );
    } catch (error) {
      console.log(
        `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=mock unable_to_build_command=${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const mockWarning = "SceneGeneration mock mode active. Set SAM3D_EXECUTION_MODE=real to run SAM3D python export.";
  if (!warnings.includes(mockWarning)) {
    warnings.push(mockWarning);
  }

  return {
    mode,
    warnings,
    outputs: buildMockOutputs({
      mode,
      warnings,
      imagePath: resolvedImagePath,
      masksDir: config.masksDir
    })
  };
}
