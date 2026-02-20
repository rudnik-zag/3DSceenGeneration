import { z } from "zod";

export type NodeCategory = "Inputs" | "Models" | "Geometry" | "Outputs";

export type PayloadKind =
  | "Image"
  | "Mask"
  | "Boxes"
  | "Text"
  | "Json"
  | "Depth"
  | "PointCloud"
  | "Mesh"
  | "TextureSet"
  | "Scene";

export type WorkflowNodeType =
  | "input.image"
  | "input.text"
  | "input.cameraPath"
  | "model.groundingdino"
  | "model.sam2"
  | "model.sam3d_objects"
  | "model.qwen_vl"
  | "model.qwen_image_edit"
  | "model.texturing"
  | "geo.depth_estimation"
  | "geo.pointcloud_from_depth"
  | "geo.mesh_reconstruction"
  | "geo.uv_unwrap"
  | "geo.bake_textures"
  | "out.export_scene"
  | "out.open_in_viewer";

export type NodeRuntimeStatus = "idle" | "running" | "success" | "error" | "cache-hit";
export type NodeUiScale = "compact" | "balanced" | "cinematic";

export interface PortSpec {
  id: string;
  label: string;
  payload: PayloadKind;
  required?: boolean;
}

export interface ParamField {
  key: string;
  label: string;
  input: "text" | "number" | "select" | "textarea" | "json" | "boolean";
  options?: string[];
  placeholder?: string;
}

export interface NodeSpec {
  type: WorkflowNodeType;
  category: NodeCategory;
  title: string;
  icon: string;
  description: string;
  inputPorts: PortSpec[];
  outputPorts: PortSpec[];
  paramSchema: z.ZodTypeAny;
  paramFields: ParamField[];
  defaultParams: Record<string, unknown>;
}

export type NodeSpecRegistry = Record<WorkflowNodeType, NodeSpec>;

export interface GraphNodeData {
  label: string;
  params: Record<string, unknown>;
  status?: NodeRuntimeStatus;
  latestArtifactId?: string;
  latestArtifactKind?: string;
  uiScale?: NodeUiScale;
}

export interface GraphNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: GraphNodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface GraphDocument {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: GraphViewport;
}

export interface ExecutionTask {
  nodeId: string;
  nodeType: WorkflowNodeType;
  params: Record<string, unknown>;
  dependsOn: string[];
}

export interface ExecutionPlan {
  tasks: ExecutionTask[];
}

export interface ArtifactRef {
  id: string;
  kind: string;
  url: string;
  hash: string;
  meta?: Record<string, unknown>;
}

export type GraphJson = GraphDocument;
