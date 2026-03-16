import { WorkflowNodeType } from "@/types/workflow";

export type TemplateGraphNode = {
  id: string;
  type: WorkflowNodeType;
  params?: Record<string, unknown>;
};

export type TemplateGraphEdge = {
  sourceNodeId: string;
  sourceOutputId: string;
  targetNodeId: string;
  targetInputId: string;
};

export type GraphDefinition = {
  nodes: TemplateGraphNode[];
  edges: TemplateGraphEdge[];
};

export type TemplateInputBinding = {
  exposedInputId: string;
  internalNodeId: string;
  internalInputId: string;
};

export type TemplateOutputBinding = {
  exposedOutputId: string;
  internalNodeId: string;
  internalOutputId: string;
};

export type TemplateParamBinding = {
  exposedParamKey: string;
  internalNodeId: string;
  internalParamKey: string;
};

export type PipelineTemplate = {
  id: string;
  name: string;
  description?: string;
  nodeType: WorkflowNodeType;
  internalGraph: GraphDefinition;
  exposedInputs: TemplateInputBinding[];
  exposedOutputs: TemplateOutputBinding[];
  exposedParams: TemplateParamBinding[];
};

const sceneGenerationTemplate: PipelineTemplate = {
  id: "template.scene_generation.v1",
  name: "SceneGeneration",
  description: "ObjectDetection -> SegmentScene -> CustomSceneGen",
  nodeType: "pipeline.scene_generation",
  internalGraph: {
    nodes: [
      { id: "detect", type: "model.groundingdino", params: {} },
      { id: "segment", type: "model.sam2", params: {} },
      { id: "custom", type: "model.sam3d_objects", params: {} }
    ],
    edges: [
      {
        sourceNodeId: "detect",
        sourceOutputId: "descriptor",
        targetNodeId: "segment",
        targetInputId: "descriptor"
      },
      {
        sourceNodeId: "segment",
        sourceOutputId: "config",
        targetNodeId: "custom",
        targetInputId: "config"
      }
    ]
  },
  exposedInputs: [
    { exposedInputId: "image", internalNodeId: "detect", internalInputId: "image" },
    { exposedInputId: "image", internalNodeId: "segment", internalInputId: "image" },
    { exposedInputId: "image", internalNodeId: "custom", internalInputId: "image" }
  ],
  exposedOutputs: [{ exposedOutputId: "generatedScene", internalNodeId: "custom", internalOutputId: "scene" }],
  exposedParams: [
    { exposedParamKey: "objectPrompt", internalNodeId: "detect", internalParamKey: "prompt" },
    { exposedParamKey: "SceneDetailedOption", internalNodeId: "custom", internalParamKey: "configPreset" },
    { exposedParamKey: "SceneOutputFormat", internalNodeId: "custom", internalParamKey: "format" },
    { exposedParamKey: "SceneMaskExecution", internalNodeId: "custom", internalParamKey: "runAllMasksInOneProcess" }
  ]
};

export const pipelineTemplates: PipelineTemplate[] = [sceneGenerationTemplate];

const pipelineTemplateByNodeType = new Map<WorkflowNodeType, PipelineTemplate>(
  pipelineTemplates.map((template) => [template.nodeType, template])
);

export function getPipelineTemplateByNodeType(nodeType: WorkflowNodeType) {
  return pipelineTemplateByNodeType.get(nodeType) ?? null;
}

export function getPipelineTemplateExecutionOrder(template: PipelineTemplate) {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of template.internalGraph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of template.internalGraph.edges) {
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    order.push(nodeId);

    for (const target of outgoing.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        queue.push(target);
      }
    }
  }

  if (order.length !== template.internalGraph.nodes.length) {
    throw new Error(`Pipeline template ${template.id} contains a cycle.`);
  }

  return order;
}
