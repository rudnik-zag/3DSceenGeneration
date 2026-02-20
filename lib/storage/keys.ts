export function artifactStorageKey(input: {
  projectId: string;
  runId: string;
  nodeId: string;
  artifactId: string;
  extension: string;
}) {
  return `projects/${input.projectId}/runs/${input.runId}/nodes/${input.nodeId}/artifact_${input.artifactId}.${input.extension}`;
}

export function artifactPreviewStorageKey(input: {
  projectId: string;
  runId: string;
  nodeId: string;
  artifactId: string;
  extension: string;
}) {
  return `projects/${input.projectId}/runs/${input.runId}/nodes/${input.nodeId}/artifact_${input.artifactId}_preview.${input.extension}`;
}
