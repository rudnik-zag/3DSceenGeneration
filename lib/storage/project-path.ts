const PROJECT_SEGMENT_FALLBACK = "shared";

function sanitizeStorageSegment(value: string, fallback: string) {
  const sanitized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

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
  runLabel: string;
  stepLabel: string;
  attempt?: number | null;
}) {
  const projectSegment = resolveProjectStorageSlug(input);
  const runSegment = sanitizeStorageSegment(input.runLabel, "run");
  const stepSegment = sanitizeStorageSegment(input.stepLabel, "step");
  const normalizedAttempt =
    Number.isFinite(Number(input.attempt)) && Number(input.attempt) > 0
      ? Math.floor(Number(input.attempt))
      : 1;
  return `projects/${projectSegment}/runs/${runSegment}/steps/${stepSegment}/attempt-${String(normalizedAttempt).padStart(2, "0")}`;
}

export function buildProjectUploadsPrefix(input: {
  projectSlug?: string | null;
  projectName?: string | null;
  projectId?: string | null;
}) {
  const projectSegment = resolveProjectStorageSlug(input);
  return `projects/${projectSegment}/uploads`;
}
