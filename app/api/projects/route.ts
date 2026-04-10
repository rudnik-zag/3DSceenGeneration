import { NextRequest, NextResponse } from "next/server";

import { assertProjectCreationEntitlement } from "@/lib/billing/entitlements";
import { requireAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { slugifyProjectName } from "@/lib/storage/project-path";
import { createProjectPayloadSchema } from "@/lib/validation/schemas";

export async function GET() {
  try {
    const user = await requireAuthUser();
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { ownerId: user.id },
          {
            members: {
              some: { userId: user.id }
            }
          }
        ]
      },
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
  } catch (error) {
    return toApiErrorResponse(error, "Failed to list projects");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuthUser();
    if (env.BILLING_ENFORCEMENT_ENABLED) {
      await assertProjectCreationEntitlement(user.id);
    }
    const body = await req.json().catch(() => ({}));
    const parsed = createProjectPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid project payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const name = parsed.data.name.trim();

    let slug = slugifyProjectName(name);
    let suffix = 1;
    // keep slug stable and unique
    while (await prisma.project.findFirst({ where: { slug }, select: { id: true } })) {
      suffix += 1;
      slug = `${slugifyProjectName(name)}-${suffix}`;
    }

    const project = await prisma.project.create({
      data: {
        ownerId: user.id,
        name,
        slug,
        members: {
          create: {
            userId: user.id,
            role: "owner"
          }
        }
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
        createdBy: user.id,
        name: "Main Graph",
        graphJson: initialGraph,
        version: 1
      }
    });

    await logAuditEventFromRequest(req, {
      action: "project_create",
      resourceType: "project",
      resourceId: project.id,
      projectId: project.id,
      userId: user.id
    });

    return NextResponse.json({ project, graph }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to create project");
  }
}
