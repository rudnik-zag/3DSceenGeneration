import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { runWorkflowQueue } from "@/lib/queue/queues";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const runs = await prisma.run.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      graph: {
        select: {
          id: true,
          name: true,
          version: true
        }
      },
      artifacts: {
        orderBy: { createdAt: "desc" }
      }
    }
  });

  return NextResponse.json({ runs });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await req.json().catch(() => ({}));

  let graphId = typeof body.graphId === "string" ? body.graphId : undefined;
  const startNodeId = typeof body.startNodeId === "string" ? body.startNodeId : undefined;

  if (!graphId) {
    const latestGraph = await prisma.graph.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { id: true }
    });
    graphId = latestGraph?.id;
  }

  if (!graphId) {
    return NextResponse.json({ error: "No graph found for project" }, { status: 400 });
  }

  const run = await prisma.run.create({
    data: {
      projectId,
      graphId,
      status: "queued",
      logs: `[${new Date().toISOString()}] Run queued`,
      progress: 0
    }
  });

  await runWorkflowQueue.add(
    "run",
    {
      projectId,
      graphId,
      runId: run.id,
      startNodeId
    },
    {
      jobId: run.id
    }
  );

  return NextResponse.json({ run }, { status: 201 });
}
