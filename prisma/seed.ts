import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

import { formatRunFolderLabel, reserveNextRunNumber } from "../lib/runs/numbering";
import { slugifyProjectName } from "../lib/storage/project-path";
import { putObjectToStorage } from "../lib/storage/s3";

const prisma = new PrismaClient();

const demoGraph = {
  nodes: [
    {
      id: "n1",
      type: "input.image",
      position: { x: 0, y: 0 },
      data: { label: "Input Image", params: { filename: "demo.jpg" }, status: "idle" }
    },
    {
      id: "n2",
      type: "model.groundingdino",
      position: { x: 320, y: -40 },
      data: { label: "ObjectDetection", params: { prompt: "person, object", threshold: 0.35 }, status: "idle" }
    },
    {
      id: "n3",
      type: "model.sam2",
      position: { x: 700, y: -20 },
      data: { label: "SegmentScene", params: { threshold: 0.5 }, status: "idle" }
    }
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", sourceHandle: "image", targetHandle: "image" },
    { id: "e2", source: "n1", target: "n3", sourceHandle: "image", targetHandle: "image" },
    { id: "e3", source: "n2", target: "n3", sourceHandle: "boxes", targetHandle: "boxes" }
  ],
  viewport: { x: 0, y: 0, zoom: 0.85 }
};

async function main() {
  const user =
    (await prisma.user.findFirst()) ??
    (await prisma.user.create({ data: { email: "demo@local.dev" } }));

  const existing = await prisma.project.findFirst({
    where: { ownerId: user.id, name: "Demo Project" },
    include: { graphs: true }
  });

  if (existing) {
    console.log("Demo project already exists:", existing.id);
    return;
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

  const graph = await prisma.graph.create({
    data: {
      projectId: project.id,
      createdBy: user.id,
      name: "Demo Graph",
      graphJson: demoGraph,
      version: 1
    }
  });

  const run = await prisma.$transaction(async (tx) => {
    const runNumber = await reserveNextRunNumber(tx, project.id);
    return tx.run.create({
      data: {
        projectId: project.id,
        graphId: graph.id,
        runNumber,
        createdBy: user.id,
        status: "success",
        logs: "Seed run created for demo project",
        progress: 100,
        startedAt: new Date(),
        finishedAt: new Date()
      }
    });
  });

  const seededArtifact = await prisma.artifact.create({
    data: {
      runId: run.id,
      projectId: project.id,
      ownerId: user.id,
      nodeId: "n3",
      kind: "mask",
      mimeType: "image/svg+xml",
      byteSize: 0,
      hash: "seed-demo-artifact",
      storageKey: "pending",
      previewStorageKey: null,
      meta: {
        seeded: true,
        label: "Demo SAM2 Mask",
        outputKey: "mask"
      }
    }
  });

  const maskSvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432" viewBox="0 0 768 432">
  <rect width="768" height="432" fill="#0B1220" />
  <rect x="120" y="90" width="220" height="180" fill="rgba(120,255,189,0.35)" />
  <rect x="390" y="140" width="180" height="160" fill="rgba(142,194,255,0.28)" />
  <text x="18" y="28" fill="#C8D2E8" font-family="Inter, sans-serif" font-size="14">SAM2 seed mask</text>
</svg>`,
    "utf8"
  );
  const hash = createHash("sha256").update(maskSvg).digest("hex");
  const projectSlug = slugifyProjectName(project.name);
  const runLabel = formatRunFolderLabel(run.runNumber);
  const storageKey = `projects/${projectSlug}/runs/${runLabel}/steps/03-image-segmentation/attempt-01/outputs/mask.svg`;

  try {
    await putObjectToStorage({
      key: storageKey,
      body: maskSvg,
      contentType: "image/svg+xml"
    });
  } catch (error) {
    console.warn("Storage upload failed during seed. Artifact row still created.", error);
  }

  const artifact = await prisma.artifact.update({
    where: { id: seededArtifact.id },
    data: {
      byteSize: maskSvg.length,
      hash,
      storageKey
    }
  });

  await prisma.cacheEntry.create({
    data: {
      projectId: project.id,
      cacheKey: "seed-cache-key-export",
      artifactId: artifact.id
    }
  });

  console.log("Seeded demo project:", project.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
