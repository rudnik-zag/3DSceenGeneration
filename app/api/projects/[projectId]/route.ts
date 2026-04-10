import { NextRequest, NextResponse } from "next/server";
import path from "path";

import { requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { buildProjectUploadsPrefix, resolveProjectStorageSlug, slugifyProjectName } from "@/lib/storage/project-path";
import { deleteStoragePrefix } from "@/lib/storage/s3";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    await requireProjectAccess(projectId, "viewer");

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        graphs: {
          orderBy: { version: "desc" },
          take: 10,
          select: { id: true, name: true, version: true, createdAt: true }
        },
        _count: {
          select: {
            runs: true,
            artifacts: true
          }
        }
      }
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ project });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read project");
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const access = await requireProjectAccess(projectId, "owner");
    const user = access.user;

    const project = await prisma.project.findFirst({
      where: {
        id: projectId
      },
      select: {
        id: true,
        name: true,
        runs: {
          select: { id: true }
        },
        artifacts: {
          select: {
            storageKey: true,
            previewStorageKey: true
          }
        },
        uploadAssets: {
          select: {
            storageKey: true
          }
        }
      }
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await logAuditEventFromRequest(_req, {
      action: "project_delete",
      resourceType: "project",
      resourceId: projectId,
      projectId,
      userId: user.id
    });

    await prisma.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({ where: { projectId } });
      await tx.cacheEntry.deleteMany({ where: { projectId } });
      await tx.artifact.deleteMany({ where: { projectId } });
      await tx.run.deleteMany({ where: { projectId } });
      await tx.graph.deleteMany({ where: { projectId } });
      await tx.project.delete({ where: { id: projectId } });
    });

    const projectSlug = resolveProjectStorageSlug({
      projectName: project.name,
      projectId: project.id
    });

    const siblingProjects = await prisma.project.findMany({
      where: {
        ownerId: user.id,
        NOT: { id: projectId }
      },
      select: { name: true }
    });
    const hasSiblingWithSameSlug = siblingProjects.some((entry) => slugifyProjectName(entry.name) === projectSlug);

    const prefixesToDelete = new Set<string>();
    prefixesToDelete.add(`projects/${projectId}/`);
    prefixesToDelete.add(`${buildProjectUploadsPrefix({ projectSlug })}/${project.id}/`);

    for (const run of project.runs) {
      prefixesToDelete.add(`projects/${projectSlug}/runs/${run.id}/`);
    }

    for (const artifact of project.artifacts) {
      const keys = [artifact.storageKey, artifact.previewStorageKey].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      for (const key of keys) {
        const parentDir = path.posix.dirname(key);
        if (parentDir && parentDir !== ".") {
          prefixesToDelete.add(`${parentDir}/`);
        }
      }
    }

    for (const uploadAsset of project.uploadAssets) {
      const uploadDir = path.posix.dirname(uploadAsset.storageKey);
      if (uploadDir && uploadDir !== ".") {
        prefixesToDelete.add(`${uploadDir}/`);
      }
    }

    if (!hasSiblingWithSameSlug) {
      prefixesToDelete.add(`projects/${projectSlug}/`);
    }

    for (const prefix of prefixesToDelete) {
      await deleteStoragePrefix(prefix);
    }

    return NextResponse.json({ ok: true, deletedProjectId: projectId, deletedProjectName: project.name });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to delete project");
  }
}
