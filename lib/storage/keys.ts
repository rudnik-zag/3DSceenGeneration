import { buildProjectRunsNodePrefix } from "@/lib/storage/project-path";

interface ArtifactStorageKeyInput {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  runId: string;
  nodeId: string;
  artifactId: string;
  extension: string;
}

export function artifactStorageKey(input: ArtifactStorageKeyInput) {
  const prefix = buildProjectRunsNodePrefix({
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    projectId: input.projectId,
    runId: input.runId,
    nodeId: input.nodeId
  });
  return `${prefix}/artifact_${input.artifactId}.${input.extension}`;
}

export function artifactPreviewStorageKey(input: ArtifactStorageKeyInput) {
  const prefix = buildProjectRunsNodePrefix({
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    projectId: input.projectId,
    runId: input.runId,
    nodeId: input.nodeId
  });
  return `${prefix}/artifact_${input.artifactId}_preview.${input.extension}`;
}
