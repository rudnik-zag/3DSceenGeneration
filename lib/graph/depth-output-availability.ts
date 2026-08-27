import { GraphNodeData, WorkflowNodeType } from "@/types/workflow";

const DEPTH_ESTIMATION_OUTPUT_IDS = new Set(["depth", "scene", "depthVideo", "sequence", "camera", "confidence", "sky", "meta"]);
const VGGT_OUTPUT_IDS = new Set(["depth", "depthVideo", "sequence", "camera", "meta"]);

function outputIdsForNodeType(nodeType: WorkflowNodeType) {
  return nodeType === "geo.vggt" ? VGGT_OUTPUT_IDS : DEPTH_ESTIMATION_OUTPUT_IDS;
}

function hasDepthRunOutputs(nodeType: WorkflowNodeType, outputArtifacts: GraphNodeData["outputArtifacts"]) {
  const outputIds = outputIdsForNodeType(nodeType);
  return Object.keys(outputArtifacts ?? {}).some((outputId) => outputIds.has(outputId));
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

function isPotentialDepthOutput(nodeType: WorkflowNodeType, params: Record<string, unknown>, outputId: string) {
  if (nodeType === "geo.vggt") {
    return VGGT_OUTPUT_IDS.has(outputId);
  }

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

function unavailableReason(nodeType: WorkflowNodeType, params: Record<string, unknown>, outputId: string) {
  if (nodeType === "geo.vggt") {
    if (outputId === "depthVideo") {
      return "Depth video is produced only for multi-frame VGGT runs.";
    }
    return "This output was not produced by the latest run.";
  }

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

export function getDepthNodeOutputAvailability(
  nodeType: WorkflowNodeType,
  params: Record<string, unknown>,
  outputArtifacts: GraphNodeData["outputArtifacts"],
  outputId: string
) {
  const potential = isPotentialDepthOutput(nodeType, params, outputId);
  const hasRuntimeOutputs = hasDepthRunOutputs(nodeType, outputArtifacts);
  const available = potential && (!hasRuntimeOutputs || hasOutputArtifact(outputArtifacts, outputId));

  return {
    available,
    reason: available ? null : unavailableReason(nodeType, params, outputId)
  };
}

export function getDepthEstimationOutputAvailability(
  params: Record<string, unknown>,
  outputArtifacts: GraphNodeData["outputArtifacts"],
  outputId: string
) {
  return getDepthNodeOutputAvailability("geo.depth_estimation", params, outputArtifacts, outputId);
}
