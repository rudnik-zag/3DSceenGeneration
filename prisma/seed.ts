import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

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
      type: "geo.depth_estimation",
      position: { x: 280, y: 0 },
      data: { label: "Depth", params: { model: "fast-depth" }, status: "idle" }
    },
    {
      id: "n3",
      type: "geo.pointcloud_from_depth",
      position: { x: 560, y: 0 },
      data: { label: "Point Cloud", params: { density: 0.75 }, status: "idle" }
    },
    {
      id: "n4",
      type: "out.export_scene",
      position: { x: 860, y: 0 },
      data: { label: "Export", params: { format: "mesh_glb" }, status: "idle" }
    }
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", sourceHandle: "image", targetHandle: "image" },
    { id: "e2", source: "n2", target: "n3", sourceHandle: "depth", targetHandle: "depth" },
    { id: "e3", source: "n3", target: "n4", sourceHandle: "pointcloud", targetHandle: "pointcloud" }
  ],
  viewport: { x: 0, y: 0, zoom: 0.85 }
};

async function main() {
  const user =
    (await prisma.user.findFirst()) ??
    (await prisma.user.create({ data: { email: "demo@local.dev" } }));

  const existing = await prisma.project.findFirst({
    where: { userId: user.id, name: "Demo Project" },
    include: { graphs: true }
  });

  if (existing) {
    console.log("Demo project already exists:", existing.id);
    return;
  }

  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: "Demo Project"
    }
  });

  const graph = await prisma.graph.create({
    data: {
      projectId: project.id,
      name: "Demo Graph",
      graphJson: demoGraph,
      version: 1
    }
  });

  const run = await prisma.run.create({
    data: {
      projectId: project.id,
      graphId: graph.id,
      status: "success",
      logs: "Seed run created for demo project",
      progress: 100,
      startedAt: new Date(),
      finishedAt: new Date()
    }
  });

  const seededArtifact = await prisma.artifact.create({
    data: {
      runId: run.id,
      projectId: project.id,
      nodeId: "n4",
      kind: "mesh_glb",
      mimeType: "model/gltf-binary",
      byteSize: 0,
      hash: "seed-demo-artifact",
      storageKey: "pending",
      previewStorageKey: null,
      meta: {
        seeded: true,
        label: "Demo GLB"
      }
    }
  });

  const glbJson = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "tribalai-workflow-studio-seed" },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: []
    }),
    "utf8"
  );
  const pad = (4 - (glbJson.length % 4)) % 4;
  const jsonChunk = pad ? Buffer.concat([glbJson, Buffer.from(" ".repeat(pad))]) : glbJson;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, 4, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  const glbBuffer = Buffer.concat([header, chunkHeader, jsonChunk]);
  const hash = createHash("sha256").update(glbBuffer).digest("hex");
  const storageKey = `projects/${project.id}/runs/${run.id}/nodes/n4/artifact_${seededArtifact.id}.glb`;

  try {
    await putObjectToStorage({
      key: storageKey,
      body: glbBuffer,
      contentType: "model/gltf-binary"
    });
  } catch (error) {
    console.warn("Storage upload failed during seed. Artifact row still created.", error);
  }

  const artifact = await prisma.artifact.update({
    where: { id: seededArtifact.id },
    data: {
      byteSize: glbBuffer.length,
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
