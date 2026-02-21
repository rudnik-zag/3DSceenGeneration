import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";
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
    select: { id: true, name: true }
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

  await deleteStoragePrefix(`projects/${projectId}/`);

  return NextResponse.json({ ok: true, deletedProjectId: projectId, deletedProjectName: project.name });
}
