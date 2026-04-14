import { ProjectRole } from "@prisma/client";
import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { requireAuthUser } from "@/lib/auth/session";
import { HttpError } from "@/lib/security/errors";

const roleRank: Record<ProjectRole, number> = {
  viewer: 10,
  editor: 20,
  owner: 30
};

function hasRole(actual: ProjectRole | null, required: ProjectRole) {
  if (!actual) return false;
  return roleRank[actual] >= roleRank[required];
}

async function resolveProjectRoleForUser(input: {
  projectId: string;
  userId: string;
}) {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: {
      id: true,
      name: true,
      slug: true,
      ownerId: true,
      members: {
        where: { userId: input.userId },
        select: { role: true },
        take: 1
      }
    }
  });
  if (!project) return null;

  const role: ProjectRole | null =
    project.ownerId === input.userId ? "owner" : project.members[0]?.role ?? null;

  return { project, role };
}

function extractProjectIdFromUploadStorageKey(storageKey: string) {
  const match = storageKey.match(/^projects\/[^/]+\/uploads\/([^/]+)\//);
  const candidate = match?.[1]?.trim();
  return candidate && candidate.length > 0 ? candidate : null;
}

function extractRunLabelFromRunsStorageKey(storageKey: string) {
  const match = storageKey.match(/^projects\/([^/]+)\/runs\/([^/]+)\//);
  const projectSlug = match?.[1]?.trim();
  const runLabel = match?.[2]?.trim();
  if (!projectSlug || !runLabel) return null;
  return { projectSlug, runLabel };
}

function parseRunNumberFromRunLabel(runLabel: string) {
  const match = runLabel.match(/^run[-_]?(\d+)$/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function extractLegacyProjectSegment(storageKey: string) {
  const match = storageKey.match(/^projects\/([^/]+)\//);
  const candidate = match?.[1]?.trim();
  return candidate && candidate.length > 0 ? candidate : null;
}

export async function requireProjectAccess(projectId: string, minimumRole: ProjectRole) {
  const user = await requireAuthUser();
  const resolved = await resolveProjectRoleForUser({
    projectId,
    userId: user.id
  });

  if (!resolved) {
    throw new HttpError(404, "Project not found", "project_not_found");
  }
  if (!hasRole(resolved.role, minimumRole)) {
    throw new HttpError(403, "Access denied", "forbidden");
  }

  return {
    user,
    project: resolved.project,
    role: resolved.role as ProjectRole
  };
}

export async function requireArtifactAccess(artifactId: string, minimumRole: ProjectRole) {
  const user = await requireAuthUser();
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    select: {
      id: true,
      projectId: true,
      ownerId: true
    }
  });
  if (!artifact) {
    throw new HttpError(404, "Artifact not found", "artifact_not_found");
  }

  const resolved = await resolveProjectRoleForUser({
    projectId: artifact.projectId,
    userId: user.id
  });
  if (!resolved || !hasRole(resolved.role, minimumRole)) {
    throw new HttpError(403, "Access denied", "forbidden");
  }

  return {
    user,
    artifact,
    project: resolved.project,
    role: resolved.role as ProjectRole
  };
}

export async function requireStorageObjectAccess(storageKey: string, minimumRole: ProjectRole) {
  const user = await requireAuthUser();
  const key = storageKey.trim();
  if (!key) {
    throw new HttpError(400, "Storage key is required", "validation_error");
  }

  const metaContainsStorageKey = {
    path: ["meshObjectStorageKeys"],
    array_contains: [key]
  } as Record<string, unknown>;

  const artifact = await prisma.artifact.findFirst({
    where: {
      OR: [
        { storageKey: key },
        { previewStorageKey: key },
        { meta: metaContainsStorageKey as never }
      ]
    },
    select: {
      id: true,
      projectId: true
    }
  });

  const uploadAsset = artifact
    ? null
    : await prisma.uploadAsset.findFirst({
        where: { storageKey: key },
        select: {
          id: true,
          projectId: true
        }
      });

  const parsedProjectId = extractProjectIdFromUploadStorageKey(key);
  const parsedRunLabel = extractRunLabelFromRunsStorageKey(key);
  const parsedLegacySegment = extractLegacyProjectSegment(key);

  const parsedRunNumber = parsedRunLabel ? parseRunNumberFromRunLabel(parsedRunLabel.runLabel) : null;
  const runProjectId =
    !artifact && !uploadAsset && parsedRunLabel && parsedRunNumber
      ? (
          await prisma.run.findFirst({
            where: {
              runNumber: parsedRunNumber,
              project: {
                slug: parsedRunLabel.projectSlug
              }
            },
            select: { projectId: true }
          })
        )?.projectId ?? null
      : null;

  const legacyProjectId =
    !artifact && !uploadAsset && !runProjectId && parsedLegacySegment
      ? (
          await prisma.project.findUnique({
            where: { id: parsedLegacySegment },
            select: { id: true }
          })
        )?.id ?? null
      : null;

  const projectId = artifact?.projectId ?? uploadAsset?.projectId ?? parsedProjectId ?? runProjectId ?? legacyProjectId;
  if (!projectId) {
    throw new HttpError(404, "Storage object not found", "storage_object_not_found");
  }

  const resolved = await resolveProjectRoleForUser({
    projectId,
    userId: user.id
  });
  if (!resolved || !hasRole(resolved.role, minimumRole)) {
    throw new HttpError(403, "Access denied", "forbidden");
  }

  return {
    user,
    project: resolved.project,
    role: resolved.role as ProjectRole,
    artifactId: artifact?.id ?? null,
    uploadAssetId: uploadAsset?.id ?? null
  };
}

export async function requireRunAccess(runId: string, minimumRole: ProjectRole) {
  const user = await requireAuthUser();
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      projectId: true
    }
  });
  if (!run) {
    throw new HttpError(404, "Run not found", "run_not_found");
  }

  const resolved = await resolveProjectRoleForUser({
    projectId: run.projectId,
    userId: user.id
  });
  if (!resolved || !hasRole(resolved.role, minimumRole)) {
    throw new HttpError(403, "Access denied", "forbidden");
  }

  return {
    user,
    run,
    project: resolved.project,
    role: resolved.role as ProjectRole
  };
}

export async function requirePageProjectAccess(projectId: string, minimumRole: ProjectRole) {
  try {
    return await requireProjectAccess(projectId, minimumRole);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      redirect("/login");
    }
    if (error instanceof HttpError && error.status === 403) {
      redirect("/forbidden");
    }
    if (error instanceof HttpError && error.status === 404) {
      notFound();
    }
    throw error;
  }
}
