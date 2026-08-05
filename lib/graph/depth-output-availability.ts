import { GraphNodeData } from "@/types/workflow";

const DEPTH_OUTPUT_IDS = new Set(["depth", "scene", "depthVideo", "sequence", "camera", "confidence", "sky", "meta"]);

function hasDepthRunOutputs(outputArtifacts: GraphNodeData["outputArtifacts"]) {
  return Object.keys(outputArtifacts ?? {}).some((outputId) => DEPTH_OUTPUT_IDS.has(outputId));
}

function hasOutputArtifact(outputArtifacts: GraphNodeData["outputArtifacts"], outputId: string) {
  return Boolean(outputArtifacts?.[outputId]?.id);
}

function resolveModelVariant(params: Record<string, unknown>) {
  return params.modelVariant === "da3metric-large" ? "da3metric-large" : "da3-base";
}

function resolveBooleanParam(params: Record<string, unknown>, key: string, fallback: boolean) {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function isPotentialDepthOutput(params: Record<string, unknown>, outputId: string) {
  const modelVariant = resolveModelVariant(params);
  const exportConfidence = resolveBooleanParam(params, "exportConfidence", true);
  const exportSky = resolveBooleanParam(params, "exportSky", true);
  const exportGlb = resolveBooleanParam(params, "exportGlb", true);

  if (outputId === "depth" || outputId === "depthVideo" || outputId === "sequence" || outputId === "meta") {
    return true;
  }
  if (outputId === "sky") {
    return exportSky;
  }
  if (outputId === "camera") {
    return modelVariant === "da3-base";
  }
  if (outputId === "scene") {
    return modelVariant === "da3-base" && exportGlb;
  }
  if (outputId === "confidence") {
    return modelVariant === "da3-base" && exportConfidence;
  }
  return true;
}

function unavailableReason(params: Record<string, unknown>, outputId: string) {
  const modelVariant = resolveModelVariant(params);
  const exportConfidence = resolveBooleanParam(params, "exportConfidence", true);
  const exportSky = resolveBooleanParam(params, "exportSky", true);
  const exportGlb = resolveBooleanParam(params, "exportGlb", true);

  if (modelVariant === "da3metric-large" && outputId === "camera") {
    return "Camera output is not produced by da3metric-large.";
  }
  if (modelVariant === "da3metric-large" && outputId === "confidence") {
    return "Confidence output is not produced by da3metric-large.";
  }
  if (modelVariant === "da3metric-large" && outputId === "scene") {
    return "GLB scene export requires DA3 pose, intrinsics, and confidence; use da3-base.";
  }
  if (outputId === "scene" && !exportGlb) {
    return "GLB scene export is disabled.";
  }
  if (outputId === "confidence" && !exportConfidence) {
    return "Confidence export is disabled.";
  }
  if (outputId === "sky" && !exportSky) {
    return "Sky export is disabled.";
  }
  return "This output was not produced by the latest run.";
}

export function getDepthEstimationOutputAvailability(
  params: Record<string, unknown>,
  outputArtifacts: GraphNodeData["outputArtifacts"],
  outputId: string
) {
  const potential = isPotentialDepthOutput(params, outputId);
  const hasRuntimeOutputs = hasDepthRunOutputs(outputArtifacts);
  const available = potential && (!hasRuntimeOutputs || hasOutputArtifact(outputArtifacts, outputId));

  return {
    available,
    reason: available ? null : unavailableReason(params, outputId)
  };
}
