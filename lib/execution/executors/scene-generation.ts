import { spawn } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult, ResolvedArtifactInput } from "@/lib/execution/contracts";
import { createJsonBuffer, createMinimalGlbBuffer, createPointCloudPlyBuffer } from "@/lib/execution/mock-assets";
import { getDefaultSam3dConfig, resolveSam3dConfigName } from "@/lib/sam3d/configs";

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
  storeOnCpu: true
};

interface SceneManifest {
  mode?: string;
  config?: string;
  scene_path?: string;
  masks_count?: number;
  image_path?: string;
  masks_dir?: string;
  created_at?: string;
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

function extensionFromMime(mimeType: string) {
  const lowered = mimeType.toLowerCase();
  if (lowered.includes("png")) return "png";
  if (lowered.includes("webp")) return "webp";
  if (lowered.includes("svg")) return "svg";
  return "jpg";
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
            `SceneGeneration process failed (exit=${code})\n` +
              `cmd: ${command} ${args.join(" ")}\n` +
              `stderr: ${stderr.slice(-10000)}`
          )
        );
      }
    });
  });
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
  const scriptPath = resolveScriptPath(repoRoot);
  const base = buildPythonInvocation(scriptPath);
  const configName = await resolveSam3dConfigName(typeof params.ctx.params.config === "string" ? params.ctx.params.config : getDefaultSam3dConfig());
  const settings = { ...SCENE_DEFAULT_SETTINGS };

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
    if (parsed && parsed.scene_path) return parsed;
  }
  return {};
}

async function collectRealOutputs(params: {
  mode: SceneMode;
  command: SceneCommand;
  processStdout: string;
  warnings: string[];
  imagePath: string;
  masksDir: string;
}) {
  const manifest = await loadManifest(params.command.outputDir, params.processStdout);
  const expected = resolveOutputKind(params.mode);
  const fallbackPath = path.join(params.command.outputDir, `scene.${expected.extension}`);
  const scenePath = manifest.scene_path ?? fallbackPath;
  const sceneBuffer = await fs.readFile(scenePath).catch((error) => {
    throw new Error(`SceneGeneration output not found at ${scenePath}: ${(error as Error).message}`);
  });

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
    masksCount: manifest.masks_count ?? null,
    settings: params.command.settings,
    warnings: params.warnings,
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

  const runMode = (process.env.SAM3D_EXECUTION_MODE ?? "mock").toLowerCase();
  if (runMode === "real") {
    const command = await buildSceneCommand({
      ctx,
      mode,
      imagePath: resolvedImagePath,
      masksDir: config.masksDir,
      outputDir
    });
    const commandLine = formatCommandLine(command.command, command.args);
    console.log(
      `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=real cmd=${commandLine}`
    );

    try {
      const processResult = await runProcess(command.command, command.args, command.cwd);
      const outputs = await collectRealOutputs({
        mode,
        command,
        processStdout: processResult.stdout,
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
        `[scene-generation] runId=${ctx.runId} nodeId=${ctx.nodeId} mode=${mode} execution=mock would_run=${mockCommandLine}`
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
