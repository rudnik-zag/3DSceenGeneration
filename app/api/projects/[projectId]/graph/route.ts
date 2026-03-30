import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { parseGraphDocument } from "@/lib/graph/plan";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { graphSavePayloadSchema } from "@/lib/validation/schemas";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    await requireProjectAccess(projectId, "viewer");

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
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read graph");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const access = await requireProjectAccess(projectId, "editor");
    const body = await req.json().catch(() => ({}));
    const parsed = graphSavePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid graph payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    let normalizedGraphJson;
    try {
      normalizedGraphJson = parseGraphDocument(parsed.data.graphJson);
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
        createdBy: access.user.id,
        name: parsed.data.name?.trim() || "Graph",
        version: (latest?.version ?? 0) + 1,
        graphJson: normalizedGraphJson as unknown as Prisma.InputJsonValue
      }
    });

    await logAuditEventFromRequest(req, {
      action: "workflow_save",
      resourceType: "graph",
      resourceId: graph.id,
      projectId,
      userId: access.user.id
    });

    return NextResponse.json({ graph }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to save graph");
  }
}
