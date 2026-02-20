import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";

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
