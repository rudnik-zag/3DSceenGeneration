import { notFound } from "next/navigation";

import { CanvasEditor } from "@/components/canvas/canvas-editor";
import { requirePageProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl } from "@/lib/storage/s3";
import { GraphDocument } from "@/types/workflow";

type CanvasNodeArtifact = {
  id: string;
  nodeId: string;
  kind: string;
  mimeType: string | null;
  artifactType: string | null;
  outputKey: string;
  hidden: boolean;
  url: string | null;
  previewUrl: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  storageKey?: string;
};

function getArtifactAttemptPrefix(storageKey: string) {
  const match = storageKey.match(/^(.*)\/outputs\/[^/]+$/);
  return match?.[1] ?? null;
}

function deriveDepthVideoStorageKey(depthStorageKey: string) {
  const attemptPrefix = getArtifactAttemptPrefix(depthStorageKey);
  return attemptPrefix ? `${attemptPrefix}/outputs/depthvideo.mp4` : null;
}

function addSyntheticDepthVideoArtifacts(artifacts: CanvasNodeArtifact[]) {
  const existingDepthVideoPrefixes = new Set(
    artifacts
      .filter((artifact) => artifact.outputKey === "depthVideo")
      .map((artifact) => artifact.storageKey)
      .filter((value): value is string => typeof value === "string")
      .map(getArtifactAttemptPrefix)
      .filter((value): value is string => Boolean(value))
  );

  const synthetic = artifacts.flatMap((artifact) => {
    const storageKey = artifact.storageKey;
    const isDepthVideoCandidate =
      artifact.nodeId.startsWith("geo.depth_estimation") &&
      artifact.outputKey === "depth" &&
      artifact.meta?.mediaType === "video" &&
      typeof storageKey === "string" &&
      storageKey.length > 0;
    if (!isDepthVideoCandidate) return [];

    const attemptPrefix = getArtifactAttemptPrefix(storageKey);
    if (!attemptPrefix || existingDepthVideoPrefixes.has(attemptPrefix)) return [];

    const depthVideoStorageKey = deriveDepthVideoStorageKey(storageKey);
    if (!depthVideoStorageKey) return [];

    return [{
      id: `${artifact.id}:depthVideo`,
      nodeId: artifact.nodeId,
      kind: "json",
      mimeType: "video/mp4",
      artifactType: "Video",
      outputKey: "depthVideo",
      hidden: false,
      url: `/api/storage/object?key=${encodeURIComponent(depthVideoStorageKey)}`,
      previewUrl: null,
      meta: {
        outputKey: "depthVideo",
        artifactType: "Video",
        semantic: "depth_video",
        mediaType: "video",
        synthetic: true,
        sourceArtifactId: artifact.id
      },
      createdAt: artifact.createdAt,
      storageKey: depthVideoStorageKey
    }];
  });

  return synthetic.length > 0 ? [...artifacts, ...synthetic] : artifacts;
}

export default async function CanvasPage({
  params
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requirePageProjectAccess(projectId, "viewer");

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
    take: 500,
    select: {
      id: true,
      nodeId: true,
      kind: true,
      mimeType: true,
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
      const artifactType = typeof meta.artifactType === "string" ? meta.artifactType : null;
      const hidden = Boolean(meta.hidden);
      const url = artifact.kind === "json" && artifact.mimeType === "application/json"
        ? `/api/storage/object?key=${encodeURIComponent(artifact.storageKey)}`
        : await safeGetSignedDownloadUrl(artifact.storageKey);
      const previewUrl = artifact.previewStorageKey
        ? await safeGetSignedDownloadUrl(artifact.previewStorageKey)
        : null;
      return {
        id: artifact.id,
        nodeId: artifact.nodeId,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        artifactType,
        outputKey,
        hidden,
        url,
        previewUrl,
        meta,
        createdAt: artifact.createdAt.toISOString(),
        storageKey: artifact.storageKey
      };
    })
  );
  const nodeArtifactsWithDepthVideos = addSyntheticDepthVideoArtifacts(nodeArtifacts);

  return (
    <CanvasEditor
      projectId={projectId}
      initialGraph={latest.graphJson as unknown as GraphDocument}
      versions={versions.map((v) => ({
        id: v.id,
        name: v.name,
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        graphJson: v.graphJson as unknown as GraphDocument
      }))}
      nodeArtifacts={nodeArtifactsWithDepthVideos}
    />
  );
}
