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

function artifactMetaArrayContains(pathKey: string, value: string) {
  return {
    path: [pathKey],
    array_contains: [value]
  } as Record<string, unknown>;
}

function parseProjectScopeFromStorageKey(storageKey: string) {
  const [root, scope] = storageKey.trim().split("/", 3);
  if (root !== "projects" || !scope) return null;
  return scope;
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

  const artifact = await prisma.artifact.findFirst({
    where: {
      OR: [
        { storageKey: key },
        { previewStorageKey: key },
        { meta: artifactMetaArrayContains("meshObjectStorageKeys", key) as never },
        { meta: artifactMetaArrayContains("sequenceFrameStorageKeys", key) as never }
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

  const projectId = artifact?.projectId ?? uploadAsset?.projectId;
  let resolved = projectId
    ? await resolveProjectRoleForUser({
        projectId,
        userId: user.id
      })
    : null;

  if (!resolved) {
    const projectScope = parseProjectScopeFromStorageKey(key);
    if (projectScope) {
      const scopedProject = await prisma.project.findFirst({
        where: {
          OR: [
            { id: projectScope },
            { slug: projectScope }
          ]
        },
        select: { id: true }
      });
      if (scopedProject) {
        resolved = await resolveProjectRoleForUser({
          projectId: scopedProject.id,
          userId: user.id
        });
      }
    }
  }

  if (!resolved || !hasRole(resolved.role, minimumRole)) {
    throw new HttpError(projectId ? 403 : 404, projectId ? "Access denied" : "Storage object not found", projectId ? "forbidden" : "storage_object_not_found");
  }

  return {
    user,
    project: resolved.project,
    role: resolved.role as ProjectRole,
    artifactId: artifact?.id ?? null,
    uploadAssetId: uploadAsset?.id ?? null
  };
}

export async function requireUploadStorageObjectAccess(storageKey: string, minimumRole: ProjectRole) {
  const user = await requireAuthUser();
  const key = storageKey.trim();
  if (!key) {
    throw new HttpError(400, "Storage key is required", "validation_error");
  }
  const uploadAsset = await prisma.uploadAsset.findUnique({
    where: { storageKey: key },
    select: {
      id: true,
      projectId: true,
      mimeType: true,
      byteSize: true,
      fileName: true
    }
  });
  if (!uploadAsset) {
    throw new HttpError(404, "Upload not found", "upload_not_found");
  }
  const resolved = await resolveProjectRoleForUser({
    projectId: uploadAsset.projectId,
    userId: user.id
  });
  if (!resolved || !hasRole(resolved.role, minimumRole)) {
    throw new HttpError(403, "Access denied", "forbidden");
  }
  return {
    user,
    project: resolved.project,
    role: resolved.role as ProjectRole,
    uploadAsset
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
