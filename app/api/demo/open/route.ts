import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export async function POST() {
  const demo = await prisma.project.findFirst({
    where: { name: "Demo Project" },
    orderBy: { createdAt: "asc" }
  });

  if (demo) {
    return NextResponse.json({ projectId: demo.id });
  }

  const user = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" }
  });

  const ensuredUser =
    user ??
    (await prisma.user.create({
      data: { email: "demo@local.dev" }
    }));

  const project = await prisma.project.create({
    data: {
      userId: ensuredUser.id,
      name: "Demo Project"
    }
  });

  await prisma.graph.create({
    data: {
      projectId: project.id,
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
            type: "model.groundingdino",
            position: { x: 320, y: -40 },
            data: { label: "GroundingDINO", params: { prompt: "person, shoes", threshold: 0.35 }, status: "idle" }
          },
          {
            id: "n3",
            type: "model.sam2",
            position: { x: 680, y: -30 },
            data: { label: "SAM2", params: { threshold: 0.5 }, status: "idle" }
          }
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2", sourceHandle: "image", targetHandle: "image" },
          { id: "e2", source: "n1", target: "n3", sourceHandle: "image", targetHandle: "image" },
          { id: "e3", source: "n2", target: "n3", sourceHandle: "boxes", targetHandle: "boxes" }
        ],
        viewport: { x: 0, y: 0, zoom: 0.9 }
      }
    }
  });

  return NextResponse.json({ projectId: project.id });
}
