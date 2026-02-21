import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";

export async function GET() {
  const user = await getOrCreateDefaultUser();
  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: {
        select: {
          graphs: true,
          runs: true
        }
      }
    }
  });

  return NextResponse.json({ projects });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled Project";

  const user = await getOrCreateDefaultUser();
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name
    }
  });

  const initialGraph = {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  };

  const graph = await prisma.graph.create({
    data: {
      projectId: project.id,
      name: "Main Graph",
      graphJson: initialGraph,
      version: 1
    }
  });

  return NextResponse.json({ project, graph }, { status: 201 });
}
