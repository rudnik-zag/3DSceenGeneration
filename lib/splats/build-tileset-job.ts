import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { Artifact, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { parseSplatTilesetPresetName } from "@/lib/splats/presets";
import { buildSplatTilesetFromPly } from "@/lib/splats/tileset-builder";
import { findLatestTilesetArtifactForSource } from "@/lib/splats/tileset-artifacts";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { getObjectBuffer, storageObjectExists } from "@/lib/storage/s3";

export interface BuildSplatTilesetJobData {
  projectId: string;
  artifactId: string;
  presetName?: string;
}

function localStorageRoot() {
  const configured = process.env.LOCAL_STORAGE_ROOT?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : path.join(process.cwd(), ".local-storage");
}

async function resolveSourcePlyPath(artifact: Artifact) {
  const localRoot = localStorageRoot();
  const localPath = path.join(localRoot, artifact.storageKey);
  if (await storageObjectExists(artifact.storageKey)) {
    try {
      await fs.access(localPath);
      return { filePath: localPath, cleanup: async () => {} };
    } catch {
      // fall through to temporary file materialization
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "splat-source-"));
  const tempFilePath = path.join(tempDir, `source_${artifact.id}.ply`);
  const buffer = await getObjectBuffer(artifact.storageKey);
  await fs.writeFile(tempFilePath, buffer);
  return {
    filePath: tempFilePath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export async function executeBuildSplatTilesetJob(data: BuildSplatTilesetJobData) {
  const presetName = parseSplatTilesetPresetName(data.presetName);
  const artifact = await prisma.artifact.findFirst({
    where: {
      id: data.artifactId,
      projectId: data.projectId
    },
    include: {
      project: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  if (!artifact) {
    throw new Error(`Source artifact "${data.artifactId}" not found for project "${data.projectId}".`);
  }

  const existing = await findLatestTilesetArtifactForSource({
    projectId: artifact.projectId,
    sourceArtifactId: artifact.id,
    presetName
  });
  if (existing) {
    return {
      reused: true,
      tilesetArtifactId: existing.id,
      tilesetStorageKey: existing.storageKey,
      presetName
    };
  }

  const projectSlug = resolveProjectStorageSlug({
    projectSlug: null,
    projectName: artifact.project.name,
    projectId: artifact.project.id
  });

  const source = await resolveSourcePlyPath(artifact);
  try {
    const result = await buildSplatTilesetFromPly({
      sourceArtifactId: artifact.id,
      sourcePlyFilePath: source.filePath,
      projectSlug,
      presetName,
      localStorageRoot: localStorageRoot()
    });

    const tilesetMeta: Prisma.InputJsonObject = {
      type: "splat_tileset",
      sourceArtifactId: artifact.id,
      presetName,
      tilesetStorageKey: result.tilesetStorageKey,
      tilesetVersion: 1,
      gaussianSemantics: result.tileset.gaussianSemantics as unknown as Prisma.InputJsonValue,
      bounds: result.tileset.bounds as unknown as Prisma.InputJsonValue,
      lodStats: result.tileset.lods.map((lod) => ({
        level: lod.level,
        tileCount: lod.tiles.length,
        splatCount: lod.tiles.reduce((sum, tile) => sum + tile.splatCount, 0),
        byteSize: lod.tiles.reduce((sum, tile) => sum + tile.byteSize, 0)
      })) as unknown as Prisma.InputJsonValue
    };

    const tilesetArtifact = await prisma.artifact.create({
      data: {
        runId: artifact.runId,
        projectId: artifact.projectId,
        nodeId: artifact.nodeId,
        kind: "json",
        mimeType: "application/json",
        byteSize: result.tilesetByteSize,
        hash: result.tilesetHash,
        storageKey: result.tilesetStorageKey,
        previewStorageKey: null,
        meta: tilesetMeta
      }
    });

    return {
      reused: false,
      tilesetArtifactId: tilesetArtifact.id,
      tilesetStorageKey: tilesetArtifact.storageKey,
      presetName,
      checksum: createHash("sha256")
        .update(`${artifact.id}:${presetName}:${result.tilesetHash}`)
        .digest("hex")
    };
  } finally {
    await source.cleanup();
  }
}
