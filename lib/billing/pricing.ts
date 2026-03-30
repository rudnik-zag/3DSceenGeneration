import { buildExecutionPlan, parseGraphDocument } from "@/lib/graph/plan";
import { WorkflowNodeType } from "@/types/workflow";

const baseNodeCost: Record<WorkflowNodeType, number> = {
  "input.image": 1,
  "input.text": 1,
  "input.cameraPath": 1,
  "viewer.environment": 2,
  "model.groundingdino": 12,
  "model.sam2": 18,
  "model.sam3d_objects": 90,
  "pipeline.scene_generation": 120,
  "model.qwen_vl": 24,
  "model.qwen_image_edit": 30,
  "model.texturing": 45,
  "geo.depth_estimation": 18,
  "geo.pointcloud_from_depth": 20,
  "geo.mesh_reconstruction": 35,
  "geo.uv_unwrap": 20,
  "geo.bake_textures": 32,
  "out.export_scene": 8,
  "out.open_in_viewer": 1
};

const advancedNodeTypes = new Set<WorkflowNodeType>([
  "model.qwen_vl",
  "model.qwen_image_edit",
  "model.texturing",
  "geo.uv_unwrap",
  "geo.bake_textures"
]);

export interface RunCostBreakdownEntry {
  nodeId: string;
  nodeType: WorkflowNodeType;
  tokens: number;
}

export interface RunCostEstimate {
  estimatedTokenCost: number;
  featureKey: string;
  policyVersion: string;
  usesAdvancedNodes: boolean;
  includesSceneGeneration: boolean;
  breakdown: RunCostBreakdownEntry[];
}

function sceneMultiplier(params: Record<string, unknown>) {
  const quality = typeof params.SceneDetailedOption === "string" ? params.SceneDetailedOption : "Default";
  const format = typeof params.SceneOutputFormat === "string" ? params.SceneOutputFormat : "mesh_glb";
  const maskMode = typeof params.SceneMaskExecution === "string" ? params.SceneMaskExecution : "all_masks";
  let multiplier = 1;
  if (quality === "HighQuality") multiplier *= 1.6;
  if (quality === "FastPreview") multiplier *= 0.75;
  if (format === "point_ply") multiplier *= 1.2;
  if (maskMode === "per_mask") multiplier *= 1.2;
  return multiplier;
}

function sam3dMultiplier(params: Record<string, unknown>) {
  const preset = typeof params.configPreset === "string" ? params.configPreset : "Default";
  const format = typeof params.format === "string" ? params.format : "mesh_glb";
  const maxObjects = Number.isFinite(Number(params.maxObjects)) ? Number(params.maxObjects) : 0;
  let multiplier = 1;
  if (preset === "HighQuality") multiplier *= 1.55;
  if (preset === "FastPreview") multiplier *= 0.72;
  if (format === "point_ply") multiplier *= 1.2;
  if (maxObjects > 0) multiplier *= Math.min(2.5, 1 + maxObjects / 20);
  return multiplier;
}

export function estimateRunTokenCost(input: {
  graphJson: unknown;
  startNodeId?: string;
}): RunCostEstimate {
  const parsedGraph = parseGraphDocument(input.graphJson);
  const plan = buildExecutionPlan(parsedGraph, input.startNodeId);
  const nodesById = new Map(parsedGraph.nodes.map((node) => [node.id, node]));
  const breakdown: RunCostBreakdownEntry[] = [];

  let includesSceneGeneration = false;
  let usesAdvancedNodes = false;
  let total = 0;

  for (const task of plan.tasks) {
    const nodeType = task.nodeType;
    const rawCost = baseNodeCost[nodeType] ?? 8;
    const node = nodesById.get(task.nodeId);
    const params =
      node?.data?.params && typeof node.data.params === "object" && !Array.isArray(node.data.params)
        ? (node.data.params as Record<string, unknown>)
        : {};

    let multiplier = 1;
    if (nodeType === "pipeline.scene_generation") {
      includesSceneGeneration = true;
      multiplier *= sceneMultiplier(params);
    }
    if (nodeType === "model.sam3d_objects") {
      includesSceneGeneration = true;
      multiplier *= sam3dMultiplier(params);
    }
    if (advancedNodeTypes.has(nodeType)) {
      usesAdvancedNodes = true;
    }

    const cost = Math.max(1, Math.round(rawCost * multiplier));
    total += cost;
    breakdown.push({
      nodeId: task.nodeId,
      nodeType,
      tokens: cost
    });
  }

  const minimumCost = includesSceneGeneration ? 40 : 8;
  total = Math.max(minimumCost, total);

  return {
    estimatedTokenCost: total,
    featureKey: includesSceneGeneration ? "workflow.scene_generation" : "workflow.standard",
    policyVersion: "2026-03-29-v1",
    usesAdvancedNodes,
    includesSceneGeneration,
    breakdown
  };
}
