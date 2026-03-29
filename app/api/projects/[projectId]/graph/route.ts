import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { parseGraphDocument } from "@/lib/graph/plan";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const versions = await prisma.graph.findMany({
    where: { projectId },
    orderBy: { version: "desc" },
    select: {
      id: true,
      name: true,
      version: true,
      createdAt: true,
      graphJson: true
    }
  });

  return NextResponse.json({
    latest: versions[0] ?? null,
    versions
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await req.json().catch(() => ({}));
  const graphJson = body.graphJson;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Graph";

  if (!graphJson || !Array.isArray(graphJson.nodes) || !Array.isArray(graphJson.edges)) {
    return NextResponse.json({ error: "Invalid graphJson payload" }, { status: 400 });
  }

  let normalizedGraphJson;
  try {
    normalizedGraphJson = parseGraphDocument(graphJson);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid graphJson payload" },
      { status: 400 }
    );
  }

  const latest = await prisma.graph.findFirst({
    where: { projectId },
    orderBy: { version: "desc" },
    select: { version: true }
  });

  const graph = await prisma.graph.create({
    data: {
      projectId,
      name,
      version: (latest?.version ?? 0) + 1,
      graphJson: normalizedGraphJson as unknown as Prisma.InputJsonValue
    }
  });

  return NextResponse.json({ graph }, { status: 201 });
}
