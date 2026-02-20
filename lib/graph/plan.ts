import { GraphDocument, GraphEdge, GraphNode, WorkflowNodeType, ExecutionPlan } from "@/types/workflow";

function byId<T extends { id: string }>(items: T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

export function parseGraphDocument(raw: unknown): GraphDocument {
  const doc = raw as GraphDocument;
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges) || !doc.viewport) {
    throw new Error("Invalid graph document");
  }
  return doc;
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

function collectDownstream(startNodeId: string, outgoing: Map<string, string[]>) {
  const visited = new Set<string>();
  const stack = [startNodeId];
  while (stack.length) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    const next = outgoing.get(nodeId) ?? [];
    for (const target of next) {
      stack.push(target);
    }
  }
  return visited;
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

export function buildExecutionPlan(document: GraphDocument, startNodeId?: string): ExecutionPlan {
  const nodesById = byId(document.nodes);
  const outgoing = buildOutgoing(document.edges);
  const incoming = buildIncoming(document.edges);

  let targetNodes: Set<string>;
  if (startNodeId) {
    if (!nodesById.has(startNodeId)) {
      throw new Error(`startNodeId ${startNodeId} not found`);
    }
    const downstream = collectDownstream(startNodeId, outgoing);
    targetNodes = new Set<string>();
    for (const nodeId of downstream) {
      collectAncestors(nodeId, incoming, targetNodes);
    }
  } else {
    targetNodes = new Set(document.nodes.map((n) => n.id));
  }

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
    nodeId: node.id,
    nodeType: node.type as WorkflowNodeType,
    params: node.data.params ?? {},
    dependsOn: incoming.get(node.id)?.filter((source) => targetNodes.has(source)) ?? []
  }));

  return { tasks };
}
