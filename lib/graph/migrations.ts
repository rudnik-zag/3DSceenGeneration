import { mergeNodeParamsWithDefaults, nodeSpecRegistry } from "@/lib/graph/node-specs";
import { GraphDocument, GraphEdge, GraphNode, WorkflowNodeType } from "@/types/workflow";

function normalizeNodeType(rawType: string): WorkflowNodeType {
  if (rawType === "model.scene_generation") {
    return "model.sam3d_objects";
  }
  if (rawType in nodeSpecRegistry) {
    return rawType as WorkflowNodeType;
  }
  return "input.text";
}

function migrateNode(node: GraphNode): GraphNode {
  const nodeType = normalizeNodeType(node.type);
  const spec = nodeSpecRegistry[nodeType];

  const rawLabel = typeof node.data?.label === "string" ? node.data.label.trim() : "";
  const migratedLabel =
    nodeType === "model.sam3d_objects" &&
    (rawLabel.toLowerCase() === "scenegeneration" || rawLabel.toLowerCase() === "scenegen")
      ? "CustomSceneGen"
      : rawLabel || spec.title;

  return {
    ...node,
    type: nodeType,
    data: {
      ...node.data,
      label: migratedLabel,
      params: mergeNodeParamsWithDefaults(nodeType, node.data?.params ?? {})
    }
  };
}

function migrateEdge(edge: GraphEdge, nodesById: Map<string, GraphNode>): GraphEdge {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);

  let sourceHandle = edge.sourceHandle;
  let targetHandle = edge.targetHandle;

  if (sourceNode?.type === "model.groundingdino" && sourceHandle === "boxes") {
    sourceHandle = "descriptor";
  }
  if (
    targetNode?.type === "model.sam2" &&
    (targetHandle === "boxes" || targetHandle === "boxesConfig")
  ) {
    targetHandle = "descriptor";
  }

  return {
    ...edge,
    sourceHandle,
    targetHandle
  };
}

export function migrateGraphDocument(document: GraphDocument): GraphDocument {
  const migratedNodes = document.nodes.map((node) => migrateNode(node));
  const nodeIds = new Set(migratedNodes.map((node) => node.id));
  const nodesById = new Map(migratedNodes.map((node) => [node.id, node]));

  const migratedEdges = document.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => migrateEdge(edge, nodesById));

  return {
    ...document,
    nodes: migratedNodes,
    edges: migratedEdges
  };
}
