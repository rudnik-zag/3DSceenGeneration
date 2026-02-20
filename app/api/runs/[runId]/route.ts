import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      artifacts: {
        orderBy: { createdAt: "desc" }
      }
    }
  });

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({ run });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  const current = await prisma.run.findUnique({ where: { id: runId } });
  if (!current) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await prisma.run.update({
    where: { id: runId },
    data: {
      status: "canceled",
      finishedAt: new Date(),
      logs: `${current.logs}\n[${new Date().toISOString()}] Cancel requested`
    }
  });

  return NextResponse.json({ run });
}
