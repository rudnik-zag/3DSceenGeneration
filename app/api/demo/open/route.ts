import { NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logAuditEvent } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { slugifyProjectName } from "@/lib/storage/project-path";

export async function POST() {
  try {
    const user = await requireAuthUser();
    const demo = await prisma.project.findFirst({
      where: { ownerId: user.id, name: "Demo Project" },
      orderBy: { createdAt: "asc" }
    });

    if (demo) {
      return NextResponse.json({ projectId: demo.id });
    }

    let slug = slugifyProjectName("Demo Project");
    let suffix = 1;
    while (await prisma.project.findFirst({ where: { slug }, select: { id: true } })) {
      suffix += 1;
      slug = `${slugifyProjectName("Demo Project")}-${suffix}`;
    }

    const project = await prisma.project.create({
      data: {
        ownerId: user.id,
        name: "Demo Project",
        slug,
        members: {
          create: {
            userId: user.id,
            role: "owner"
          }
        }
      }
    });

    await prisma.graph.create({
      data: {
        projectId: project.id,
        createdBy: user.id,
        name: "Demo Graph",
        version: 1,
        graphJson: {
          nodes: [
            {
              id: "n1",
              type: "input.image",
              position: { x: 0, y: 0 },
              data: { label: "Input Image", params: { filename: "demo.png", storageKey: "" }, status: "idle" }
            },
            {
              id: "n2",
              type: "pipeline.scene_generation",
              position: { x: 360, y: -20 },
              data: {
                label: "SceneGeneration",
                params: { objectPrompt: "person, shoes", SceneDetailedOption: "Default", SceneOutputFormat: "mesh_glb" },
                status: "idle"
              }
            }
          ],
          edges: [
            { id: "e1", source: "n1", target: "n2", sourceHandle: "image", targetHandle: "image" }
          ],
          viewport: { x: 0, y: 0, zoom: 0.9 }
        }
      }
    });

    await logAuditEvent({
      action: "project_create",
      resourceType: "project",
      resourceId: project.id,
      projectId: project.id,
      userId: user.id
    });

    return NextResponse.json({ projectId: project.id });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to open demo project");
  }
}
