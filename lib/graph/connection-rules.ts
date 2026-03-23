import { nodeSpecRegistry } from "@/lib/graph/node-specs";
import { areArtifactTypesCompatible } from "@/lib/graph/artifact-types";
import { GraphNode, WorkflowNodeType } from "@/types/workflow";

interface ConnectionCandidate {
  sourceNodeType: WorkflowNodeType;
  targetNodeType: WorkflowNodeType;
  sourceHandleId?: string | null;
  targetHandleId?: string | null;
}

interface ConnectionValidationResult {
  valid: boolean;
  reason?: string;
  sourceHandleId?: string;
  targetHandleId?: string;
}

function normalizeHandleId(nodeType: WorkflowNodeType, handleId: string | null | undefined, direction: "source" | "target") {
  if (!handleId) return undefined;

  if (nodeType === "model.groundingdino" && direction === "source" && handleId === "boxes") {
    return "descriptor";
  }

  if (
    nodeType === "model.sam2" &&
    direction === "target" &&
    (handleId === "boxes" || handleId === "boxesConfig")
  ) {
    return "descriptor";
  }

  if (
    nodeType === "out.open_in_viewer" &&
    direction === "target" &&
    (handleId === "scene" || handleId === "json")
  ) {
    return "artifact";
  }

  return handleId;
}

export function validateConnectionByNodeTypes(candidate: ConnectionCandidate): ConnectionValidationResult {
  const sourceSpec = nodeSpecRegistry[candidate.sourceNodeType];
  const targetSpec = nodeSpecRegistry[candidate.targetNodeType];
  if (!sourceSpec || !targetSpec) {
    return { valid: false, reason: "Unknown node type" };
  }

  const normalizedSourceHandle = normalizeHandleId(
    candidate.sourceNodeType,
    candidate.sourceHandleId,
    "source"
  );
  const normalizedTargetHandle = normalizeHandleId(
    candidate.targetNodeType,
    candidate.targetHandleId,
    "target"
  );

  const sourcePort = normalizedSourceHandle
    ? sourceSpec.outputPorts.find((port) => port.id === normalizedSourceHandle)
    : sourceSpec.outputPorts[0];
  const targetPort = normalizedTargetHandle
    ? targetSpec.inputPorts.find((port) => port.id === normalizedTargetHandle)
    : targetSpec.inputPorts[0];

  if (!sourcePort || !targetPort) {
    return { valid: false, reason: "Missing source/target handle" };
  }

  // Preview sink accepts any connected artifact type on its single input.
  if (candidate.targetNodeType === "out.open_in_viewer" && targetPort.id === "artifact") {
    return {
      valid: true,
      sourceHandleId: sourcePort.id,
      targetHandleId: targetPort.id
    };
  }

  if (!areArtifactTypesCompatible(sourcePort.artifactType, targetPort.artifactType)) {
    return {
      valid: false,
      reason: `Type mismatch (${sourcePort.artifactType} -> ${targetPort.artifactType})`
    };
  }

  // Extra domain rule: SegmentScene.descriptor accepts Descriptor only from ObjectDetection.descriptor.
  if (candidate.targetNodeType === "model.sam2" && targetPort.id === "descriptor") {
    if (candidate.sourceNodeType !== "model.groundingdino" || sourcePort.id !== "descriptor") {
      return {
        valid: false,
        reason: "SegmentScene descriptor accepts only ObjectDetection.descriptor"
      };
    }
  }

  return {
    valid: true,
    sourceHandleId: sourcePort.id,
    targetHandleId: targetPort.id
  };
}

export function validateConnectionForEdge(params: {
  nodesById: Map<string, GraphNode>;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandleId?: string | null;
  targetHandleId?: string | null;
}) {
  const sourceNode = params.nodesById.get(params.sourceNodeId);
  const targetNode = params.nodesById.get(params.targetNodeId);

  if (!sourceNode || !targetNode) {
    return { valid: false, reason: "Missing source or target node" } as ConnectionValidationResult;
  }

  return validateConnectionByNodeTypes({
    sourceNodeType: sourceNode.type,
    targetNodeType: targetNode.type,
    sourceHandleId: params.sourceHandleId,
    targetHandleId: params.targetHandleId
  });
}

export function findFirstCompatibleHandles(sourceNodeType: WorkflowNodeType, targetNodeType: WorkflowNodeType) {
  const sourceSpec = nodeSpecRegistry[sourceNodeType];
  const targetSpec = nodeSpecRegistry[targetNodeType];
  if (!sourceSpec || !targetSpec) return null;

  for (const sourcePort of sourceSpec.outputPorts) {
    for (const targetPort of targetSpec.inputPorts) {
      const result = validateConnectionByNodeTypes({
        sourceNodeType,
        targetNodeType,
        sourceHandleId: sourcePort.id,
        targetHandleId: targetPort.id
      });
      if (result.valid) {
        return {
          sourceHandleId: result.sourceHandleId ?? sourcePort.id,
          targetHandleId: result.targetHandleId ?? targetPort.id
        };
      }
    }
  }

  return null;
}

export function normalizeEdgeHandles(
  edge: { sourceHandle?: string; targetHandle?: string },
  sourceNodeType: WorkflowNodeType,
  targetNodeType: WorkflowNodeType
) {
  return {
    sourceHandle: normalizeHandleId(sourceNodeType, edge.sourceHandle, "source"),
    targetHandle: normalizeHandleId(targetNodeType, edge.targetHandle, "target")
  };
}
