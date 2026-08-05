import { GraphDocument, GraphEdge, GraphNode, WorkflowNodeType, ExecutionPlan } from "@/types/workflow";
import { validateConnectionForEdge } from "@/lib/graph/connection-rules";
import { migrateGraphDocument } from "@/lib/graph/migrations";
import { mergeNodeParamsWithDefaults, nodeSpecRegistry } from "@/lib/graph/node-specs";

function byId<T extends { id: string }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

export function parseGraphDocument(raw: unknown): GraphDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid graph document");
  }
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new Error("Invalid graph document");
  }
  if (input.nodes.length > 250 || input.edges.length > 1000) {
    throw new Error("Graph exceeds node or edge limits");
  }
  if (!input.viewport || typeof input.viewport !== "object" || Array.isArray(input.viewport)) {
    throw new Error("Invalid graph viewport");
  }
  const viewportInput = input.viewport as Record<string, unknown>;
  const viewport = {
    x: Number(viewportInput.x),
    y: Number(viewportInput.y),
    zoom: Number(viewportInput.zoom)
  };
  if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0 || viewport.zoom > 8) {
    throw new Error("Invalid graph viewport");
  }

  const nodeIds = new Set<string>();
  const nodes = input.nodes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid graph node at index ${index}`);
    }
    const node = entry as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id.trim() : "";
    const rawType = typeof node.type === "string" ? node.type : "";
    const nodeType = rawType === "model.scene_generation" ? "model.sam3d_objects" : rawType;
    if (!id || id.length > 180 || nodeIds.has(id)) {
      throw new Error(`Invalid or duplicate graph node id at index ${index}`);
    }
    if (!(nodeType in nodeSpecRegistry)) {
      throw new Error(`Unsupported graph node type: ${rawType || "unknown"}`);
    }
    const positionInput =
      node.position && typeof node.position === "object" && !Array.isArray(node.position)
        ? (node.position as Record<string, unknown>)
        : null;
    const position = {
      x: Number(positionInput?.x),
      y: Number(positionInput?.y)
    };
    if (![position.x, position.y].every(Number.isFinite)) {
      throw new Error(`Invalid graph node position: ${id}`);
    }
    const dataInput =
      node.data && typeof node.data === "object" && !Array.isArray(node.data)
        ? (node.data as Record<string, unknown>)
        : {};
    const label = typeof dataInput.label === "string" ? dataInput.label.trim() : "";
    if (label.length > 120) {
      throw new Error(`Graph node label is too long: ${id}`);
    }
    const params = mergeNodeParamsWithDefaults(
      nodeType as WorkflowNodeType,
      dataInput.params
    );
    nodeIds.add(id);
    return {
      id,
      type: nodeType as WorkflowNodeType,
      position,
      data: {
        ...dataInput,
        label: label || nodeSpecRegistry[nodeType as WorkflowNodeType].title,
        params
      }
    } as GraphNode;
  });

  const edges = input.edges.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid graph edge at index ${index}`);
    }
    const edge = entry as Record<string, unknown>;
    const id = typeof edge.id === "string" ? edge.id.trim() : "";
    const source = typeof edge.source === "string" ? edge.source.trim() : "";
    const target = typeof edge.target === "string" ? edge.target.trim() : "";
    const sourceHandle = typeof edge.sourceHandle === "string" ? edge.sourceHandle.trim() : undefined;
    const targetHandle = typeof edge.targetHandle === "string" ? edge.targetHandle.trim() : undefined;
    if (!id || id.length > 180 || !nodeIds.has(source) || !nodeIds.has(target)) {
      throw new Error(`Invalid graph edge at index ${index}`);
    }
    if ((sourceHandle?.length ?? 0) > 120 || (targetHandle?.length ?? 0) > 120) {
      throw new Error(`Invalid graph edge handles at index ${index}`);
    }
    return { id, source, target, sourceHandle, targetHandle } as GraphEdge;
  });

  const doc: GraphDocument = { nodes, edges, viewport };
  const migrated = migrateGraphDocument(doc);
  const nodesById = byId(migrated.nodes);
  const validEdges = migrated.edges.reduce<GraphEdge[]>((acc, edge) => {
    const result = validateConnectionForEdge({
      nodesById,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourceHandleId: edge.sourceHandle,
      targetHandleId: edge.targetHandle
    });
    if (!result.valid) {
      return acc;
    }
    acc.push({
      ...edge,
      sourceHandle: result.sourceHandleId ?? edge.sourceHandle,
      targetHandle: result.targetHandleId ?? edge.targetHandle
    });
    return acc;
  }, []);

  const normalized = {
    ...migrated,
    edges: validEdges
  };
  buildExecutionPlan(normalized);
  return normalized;
}

function buildOutgoing(edges: GraphEdge[]) {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const list = map.get(edge.source) ?? [];
    list.push(edge.target);
    map.set(edge.source, list);
  }
  return map;
}

function buildIncoming(edges: GraphEdge[]) {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const list = map.get(edge.target) ?? [];
    list.push(edge.source);
    map.set(edge.target, list);
  }
  return map;
}

function collectAncestors(nodeId: string, incoming: Map<string, string[]>, sink: Set<string>) {
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop()!;
    if (sink.has(current)) {
      continue;
    }
    sink.add(current);
    const prev = incoming.get(current) ?? [];
    for (const source of prev) {
      stack.push(source);
    }
  }
}

function resolveBindingFromEdge(edge: GraphEdge, nodesById: Map<string, GraphNode>) {
  const sourceNode = nodesById.get(edge.source);
  const targetNode = nodesById.get(edge.target);
  if (!sourceNode || !targetNode) return null;

  const sourceSpec = nodeSpecRegistry[sourceNode.type as WorkflowNodeType];
  const targetSpec = nodeSpecRegistry[targetNode.type as WorkflowNodeType];
  if (!sourceSpec || !targetSpec) return null;

  const sourceOutputId = edge.sourceHandle ?? sourceSpec.outputPorts[0]?.id;
  const inputPortId = edge.targetHandle ?? targetSpec.inputPorts[0]?.id;
  if (!sourceOutputId || !inputPortId) return null;

  return {
    inputPortId,
    sourceNodeId: edge.source,
    sourceOutputId
  };
}

export function buildExecutionPlan(document: GraphDocument, startNodeId?: string): ExecutionPlan {
  const nodesById = byId(document.nodes);
  const incoming = buildIncoming(document.edges);

  let targetNodes: Set<string>;
  if (startNodeId) {
    if (!nodesById.has(startNodeId)) {
      throw new Error(`startNodeId ${startNodeId} not found`);
    }
    targetNodes = new Set<string>();
    collectAncestors(startNodeId, incoming, targetNodes);
  } else {
    targetNodes = new Set(document.nodes.map((n) => n.id));
  }

  const outgoing = buildOutgoing(
    document.edges.filter((edge) => targetNodes.has(edge.source) && targetNodes.has(edge.target))
  );

  const indegree = new Map<string, number>();
  for (const nodeId of targetNodes) {
    indegree.set(nodeId, 0);
  }

  for (const edge of document.edges) {
    if (targetNodes.has(edge.source) && targetNodes.has(edge.target)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [nodeId, deg] of indegree.entries()) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  const ordered: GraphNode[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    const node = nodesById.get(nodeId);
    if (!node) {
      continue;
    }

    ordered.push(node);

    for (const next of outgoing.get(nodeId) ?? []) {
      if (!targetNodes.has(next)) {
        continue;
      }
      const newValue = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newValue);
      if (newValue === 0) {
        queue.push(next);
      }
    }
  }

  if (ordered.length !== targetNodes.size) {
    throw new Error("Graph contains a cycle or disconnected dependency issue");
  }

  const tasks = ordered.map((node) => ({
    inputBindings: document.edges
      .filter((edge) => edge.target === node.id && targetNodes.has(edge.source))
      .map((edge) => resolveBindingFromEdge(edge, nodesById))
      .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding)),
    nodeId: node.id,
    nodeType: node.type as WorkflowNodeType,
    params: node.data.params ?? {},
    dependsOn: incoming.get(node.id)?.filter((source) => targetNodes.has(source)) ?? []
  }));

  return { tasks };
}
