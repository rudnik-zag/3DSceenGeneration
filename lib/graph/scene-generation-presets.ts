export type SceneGenerationConfigPreset = "Default" | "HighQuality" | "FastPreview" | "Custom";

export interface SceneGenerationParams extends Record<string, unknown> {
  configPreset: SceneGenerationConfigPreset;
  format: "mesh_glb" | "point_ply";
  config: string;
  runAllMasksInOneProcess: boolean;
  maxObjects: number;
  enableMesh: boolean;
  exportMeshGlb: boolean;
  enableMeshScene: boolean;
  meshPostprocess: boolean;
  textureBaking: boolean;
  decodeMesh: boolean;
  stage1Steps: number;
  stage2Steps: number;
  fallbackStage1Steps: number;
  fallbackStage2Steps: number;
  autocast: boolean;
  autocastPreferBf16: boolean;
  storeOnCpu: boolean;
}

export const sceneGenerationDefaultParams: SceneGenerationParams = {
  configPreset: "Default",
  format: "mesh_glb",
  config: "hf",
  runAllMasksInOneProcess: true,
  maxObjects: 0,
  enableMesh: true,
  exportMeshGlb: true,
  enableMeshScene: true,
  meshPostprocess: false,
  textureBaking: false,
  decodeMesh: true,
  stage1Steps: 0,
  stage2Steps: 0,
  fallbackStage1Steps: 15,
  fallbackStage2Steps: 15,
  autocast: false,
  autocastPreferBf16: false,
  storeOnCpu: true
};

const SCENE_GENERATION_PRESETS: Record<
  Exclude<SceneGenerationConfigPreset, "Custom">,
  Omit<SceneGenerationParams, "configPreset" | "format" | "config">
> = {
  Default: {
    runAllMasksInOneProcess: true,
    maxObjects: 0,
    enableMesh: true,
    exportMeshGlb: true,
    enableMeshScene: true,
    meshPostprocess: false,
    textureBaking: false,
    decodeMesh: true,
    stage1Steps: 0,
    stage2Steps: 0,
    fallbackStage1Steps: 15,
    fallbackStage2Steps: 15,
    autocast: false,
    autocastPreferBf16: false,
    storeOnCpu: true
  },
  HighQuality: {
    runAllMasksInOneProcess: true,
    maxObjects: 0,
    enableMesh: true,
    exportMeshGlb: true,
    enableMeshScene: true,
    meshPostprocess: true,
    textureBaking: true,
    decodeMesh: true,
    stage1Steps: 28,
    stage2Steps: 24,
    fallbackStage1Steps: 20,
    fallbackStage2Steps: 20,
    autocast: true,
    autocastPreferBf16: true,
    storeOnCpu: false
  },
  FastPreview: {
    runAllMasksInOneProcess: true,
    maxObjects: 8,
    enableMesh: true,
    exportMeshGlb: true,
    enableMeshScene: true,
    meshPostprocess: false,
    textureBaking: false,
    decodeMesh: true,
    stage1Steps: 12,
    stage2Steps: 10,
    fallbackStage1Steps: 10,
    fallbackStage2Steps: 10,
    autocast: true,
    autocastPreferBf16: false,
    storeOnCpu: true
  }
};

export function getSceneGenerationPresetNames(): SceneGenerationConfigPreset[] {
  return ["Default", "HighQuality", "FastPreview", "Custom"];
}

function asFiniteInt(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.round(numberValue);
}

function asBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function normalizeSceneGenerationParams(rawParams: Record<string, unknown> | null | undefined): SceneGenerationParams {
  const raw = rawParams ?? {};
  const explicitPreset =
    raw.configPreset === "HighQuality" ||
    raw.configPreset === "FastPreview" ||
    raw.configPreset === "Custom" ||
    raw.configPreset === "Default"
      ? raw.configPreset
      : null;
  const hasLegacyParams = Object.keys(raw).length > 0;

  return {
    configPreset: explicitPreset ?? (hasLegacyParams ? "Custom" : "Default"),
    format: raw.format === "point_ply" ? "point_ply" : "mesh_glb",
    config: typeof raw.config === "string" && raw.config.trim().length > 0 ? raw.config.trim() : sceneGenerationDefaultParams.config,
    runAllMasksInOneProcess: asBoolean(raw.runAllMasksInOneProcess, sceneGenerationDefaultParams.runAllMasksInOneProcess),
    maxObjects: asFiniteInt(raw.maxObjects, sceneGenerationDefaultParams.maxObjects),
    enableMesh: asBoolean(raw.enableMesh, sceneGenerationDefaultParams.enableMesh),
    exportMeshGlb: asBoolean(raw.exportMeshGlb, sceneGenerationDefaultParams.exportMeshGlb),
    enableMeshScene: asBoolean(raw.enableMeshScene, sceneGenerationDefaultParams.enableMeshScene),
    meshPostprocess: asBoolean(raw.meshPostprocess, sceneGenerationDefaultParams.meshPostprocess),
    textureBaking: asBoolean(raw.textureBaking, sceneGenerationDefaultParams.textureBaking),
    decodeMesh: asBoolean(raw.decodeMesh, sceneGenerationDefaultParams.decodeMesh),
    stage1Steps: asFiniteInt(raw.stage1Steps, sceneGenerationDefaultParams.stage1Steps),
    stage2Steps: asFiniteInt(raw.stage2Steps, sceneGenerationDefaultParams.stage2Steps),
    fallbackStage1Steps: asFiniteInt(raw.fallbackStage1Steps, sceneGenerationDefaultParams.fallbackStage1Steps),
    fallbackStage2Steps: asFiniteInt(raw.fallbackStage2Steps, sceneGenerationDefaultParams.fallbackStage2Steps),
    autocast: asBoolean(raw.autocast, sceneGenerationDefaultParams.autocast),
    autocastPreferBf16: asBoolean(raw.autocastPreferBf16, sceneGenerationDefaultParams.autocastPreferBf16),
    storeOnCpu: asBoolean(raw.storeOnCpu, sceneGenerationDefaultParams.storeOnCpu)
  };
}

export function mergeSceneGenerationParams(rawParams: Record<string, unknown> | null | undefined): SceneGenerationParams {
  const merged = normalizeSceneGenerationParams(rawParams);

  if (merged.configPreset === "Custom") {
    return merged;
  }

  return applySceneGenerationPreset(merged, merged.configPreset);
}

export function applySceneGenerationPreset(
  currentParams: Record<string, unknown> | SceneGenerationParams,
  presetName: SceneGenerationConfigPreset
): SceneGenerationParams {
  const normalized = normalizeSceneGenerationParams(currentParams as Record<string, unknown>);
  if (presetName === "Custom") {
    return { ...normalized, configPreset: "Custom" };
  }

  const preset = SCENE_GENERATION_PRESETS[presetName] ?? SCENE_GENERATION_PRESETS.Default;
  // Preserve explicit mask execution mode across preset changes.
  const preservedMaskMode = normalized.runAllMasksInOneProcess;
  return {
    ...normalized,
    ...preset,
    runAllMasksInOneProcess: preservedMaskMode,
    configPreset: presetName
  };
}
