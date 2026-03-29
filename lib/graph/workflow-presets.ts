import { mergeNodeParamsWithDefaults, nodeSpecRegistry } from "@/lib/graph/node-specs";
import { GraphEdge, GraphNode, GraphNodeData, WorkflowNodeType } from "@/types/workflow";

export type WorkflowPreset = {
  id: string;
  label: string;
  description?: string;
  buildNodesAndEdges: (input: {
    anchor: { x: number; y: number };
    createNodeId: (type: WorkflowNodeType) => string;
    uiScale: GraphNodeData["uiScale"];
  }) => {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
};

const sceneGenerationWorkflowPreset: WorkflowPreset = {
  id: "scene_generation",
  label: "SceneGeneration",
  description: "Insert ImageInput -> SceneGeneration starter workflow",
  buildNodesAndEdges: ({ anchor, createNodeId, uiScale }) => {
    const imageNodeId = createNodeId("input.image");
    const sceneNodeId = createNodeId("pipeline.scene_generation");

    const imageSpec = nodeSpecRegistry["input.image"];
    const sceneSpec = nodeSpecRegistry["pipeline.scene_generation"];

    return {
      nodes: [
        {
          id: imageNodeId,
          type: "input.image",
          position: { x: anchor.x - 280, y: anchor.y - 40 },
          data: {
            label: imageSpec.title,
            params: mergeNodeParamsWithDefaults("input.image", imageSpec.defaultParams),
            status: "idle",
            uiScale
          }
        },
        {
          id: sceneNodeId,
          type: "pipeline.scene_generation",
          position: { x: anchor.x + 60, y: anchor.y - 30 },
          data: {
            label: sceneSpec.title,
            params: mergeNodeParamsWithDefaults("pipeline.scene_generation", sceneSpec.defaultParams),
            status: "idle",
            uiScale
          }
        }
      ],
      edges: [
        {
          id: `e-${imageNodeId}-${sceneNodeId}`,
          source: imageNodeId,
          target: sceneNodeId,
          sourceHandle: "image",
          targetHandle: "image"
        }
      ]
    };
  }
};

export const workflowPresets: WorkflowPreset[] = [sceneGenerationWorkflowPreset];

export function getWorkflowPresetById(id: string) {
  return workflowPresets.find((preset) => preset.id === id) ?? null;
}
