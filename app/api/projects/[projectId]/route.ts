import { NextRequest, NextResponse } from "next/server";
import path from "path";

import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";
import { buildProjectUploadsPrefix, resolveProjectStorageSlug, slugifyProjectName } from "@/lib/storage/project-path";
import { deleteStoragePrefix } from "@/lib/storage/s3";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

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
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const user = await getOrCreateDefaultUser();

  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      userId: user.id
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

  await prisma.$transaction(async (tx) => {
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
      userId: user.id,
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
}
