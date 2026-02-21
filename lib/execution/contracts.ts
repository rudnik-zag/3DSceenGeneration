import { ArtifactKind } from "@prisma/client";

import { WorkflowNodeType } from "@/types/workflow";

export interface ResolvedArtifactInput {
  artifactId: string;
  nodeId: string;
  outputId: string;
  kind: ArtifactKind;
  hash: string;
  mimeType: string;
  storageKey: string;
  byteSize: number;
  meta: Record<string, unknown>;
}

export interface ExecutorOutputArtifact {
  outputId: string;
  kind: ArtifactKind;
  mimeType: string;
  extension: string;
  buffer: Buffer;
  meta?: Record<string, unknown>;
  hidden?: boolean;
  preview?: {
    extension: string;
    mimeType: string;
    buffer: Buffer;
  };
}

export interface NodeExecutionContext {
  projectId: string;
  runId: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  params: Record<string, unknown>;
  inputs: Record<string, ResolvedArtifactInput[]>;
  mode?: string;
  warnings?: string[];
  loadInputBuffer: (input: ResolvedArtifactInput) => Promise<Buffer>;
}

export interface NodeExecutionResult {
  outputs: ExecutorOutputArtifact[];
  mode?: string;
  warnings?: string[];
}

export interface NodeExecutor {
  executeNode: (ctx: NodeExecutionContext) => Promise<NodeExecutionResult>;
}
