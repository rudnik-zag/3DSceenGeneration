import { notFound } from "next/navigation";

import { CanvasEditor } from "@/components/canvas/canvas-editor";
import { prisma } from "@/lib/db";
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
      createdAt: true
    }
  });

  const dedup = new Map<string, { id: string; nodeId: string; kind: string }>();
  for (const artifact of artifacts) {
    if (!dedup.has(artifact.nodeId)) {
      dedup.set(artifact.nodeId, {
        id: artifact.id,
        nodeId: artifact.nodeId,
        kind: artifact.kind
      });
    }
  }

  return (
    <CanvasEditor
      projectId={projectId}
      projectName={project.name}
      initialGraph={latest.graphJson as GraphDocument}
      versions={versions.map((v) => ({
        id: v.id,
        name: v.name,
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        graphJson: v.graphJson as GraphDocument
      }))}
      nodeArtifacts={[...dedup.values()]}
    />
  );
}
