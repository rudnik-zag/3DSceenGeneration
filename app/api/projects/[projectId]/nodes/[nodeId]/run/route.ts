import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { runWorkflowQueue } from "@/lib/queue/queues";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; nodeId: string }> }
) {
  const { projectId, nodeId } = await params;
  const body = await req.json().catch(() => ({}));
  const forceNodeCacheBypass = body.forceNodeCacheBypass !== false;

  let graphId = typeof body.graphId === "string" ? body.graphId : undefined;
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
      logs: `[${new Date().toISOString()}] Node run queued (${nodeId}) forceCacheBypass=${forceNodeCacheBypass}`,
      progress: 0
    }
  });

  await runWorkflowQueue.add(
    "run",
    {
      projectId,
      graphId,
      runId: run.id,
      startNodeId: nodeId,
      forceNodeIds: forceNodeCacheBypass ? [nodeId] : []
    },
    {
      jobId: run.id
    }
  );

  return NextResponse.json({ run }, { status: 201 });
}
