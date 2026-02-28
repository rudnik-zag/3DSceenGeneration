const PROJECT_SEGMENT_FALLBACK = "shared";

export function slugifyProjectName(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function resolveProjectStorageSlug(input: {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  fallback?: string;
}) {
  const explicitSlug = typeof input.projectSlug === "string" ? input.projectSlug.trim().toLowerCase() : "";
  if (explicitSlug) {
    return explicitSlug.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "project";
  }

  if (typeof input.projectName === "string" && input.projectName.trim().length > 0) {
    return slugifyProjectName(input.projectName);
  }

  const idFallback = typeof input.projectId === "string" ? input.projectId.trim().toLowerCase() : "";
  if (idFallback) {
    return idFallback.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || PROJECT_SEGMENT_FALLBACK;
  }

  return input.fallback ?? PROJECT_SEGMENT_FALLBACK;
}

export function buildProjectRunsNodePrefix(input: {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  runId: string;
  nodeId: string;
}) {
  const projectSegment = resolveProjectStorageSlug(input);
  return `projects/${projectSegment}/runs/${input.runId}/nodes/${input.nodeId}`;
}

export function buildProjectUploadsPrefix(input: {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
}) {
  const projectSegment = resolveProjectStorageSlug(input);
  return `projects/${projectSegment}/uploads`;
}
