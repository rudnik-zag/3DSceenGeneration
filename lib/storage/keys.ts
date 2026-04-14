import { buildProjectRunsNodePrefix } from "@/lib/storage/project-path";

interface ArtifactStorageKeyInput {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  runLabel: string;
  stepLabel: string;
  attempt?: number | null;
  outputName: string;
  extension: string;
}

export function artifactStorageKey(input: ArtifactStorageKeyInput) {
  const prefix = buildProjectRunsNodePrefix({
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    projectId: input.projectId,
    runLabel: input.runLabel,
    stepLabel: input.stepLabel,
    attempt: input.attempt
  });
  return `${prefix}/outputs/${input.outputName}.${input.extension}`;
}

export function artifactPreviewStorageKey(input: ArtifactStorageKeyInput) {
  const prefix = buildProjectRunsNodePrefix({
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    projectId: input.projectId,
    runLabel: input.runLabel,
    stepLabel: input.stepLabel,
    attempt: input.attempt
  });
  return `${prefix}/outputs/${input.outputName}_preview.${input.extension}`;
}
