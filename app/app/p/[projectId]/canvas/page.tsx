import { notFound } from "next/navigation";

import { CanvasEditor } from "@/components/canvas/canvas-editor";
import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";
import { GraphDocument } from "@/types/workflow";

export default async function CanvasPage({
  params
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    notFound();
  }

  const versions = await prisma.graph.findMany({
    where: { projectId },
    orderBy: { version: "desc" },
    take: 25,
    select: {
      id: true,
      name: true,
      version: true,
      createdAt: true,
      graphJson: true
    }
  });

  const latest = versions[0];
  if (!latest) {
    notFound();
  }

  const artifacts = await prisma.artifact.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      nodeId: true,
      kind: true,
      createdAt: true,
      meta: true,
      storageKey: true,
      previewStorageKey: true
    }
  });

  const nodeArtifacts = await Promise.all(
    artifacts.map(async (artifact) => {
      const meta =
        artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)
          ? (artifact.meta as Record<string, unknown>)
          : {};
      const outputKey = typeof meta.outputKey === "string" ? meta.outputKey : "default";
      const hidden = Boolean(meta.hidden);
      const url = await safeGetSignedDownloadUrl(artifact.storageKey);
      const previewUrl = artifact.previewStorageKey
        ? await safeGetSignedDownloadUrl(artifact.previewStorageKey)
        : null;
      return {
        id: artifact.id,
        nodeId: artifact.nodeId,
        kind: artifact.kind,
        outputKey,
        hidden,
        url,
        previewUrl,
        meta,
        createdAt: artifact.createdAt.toISOString()
      };
    })
  );

  return (
    <CanvasEditor
      projectId={projectId}
      projectName={project.name}
      initialGraph={latest.graphJson as unknown as GraphDocument}
      versions={versions.map((v) => ({
        id: v.id,
        name: v.name,
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        graphJson: v.graphJson as unknown as GraphDocument
      }))}
      nodeArtifacts={nodeArtifacts}
    />
  );
}
