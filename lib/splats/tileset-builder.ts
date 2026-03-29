import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import { getSplatTilesetPreset } from "@/lib/splats/presets";
import { createLockedSplatPlyHeader, iterateLockedPlyRecords, parseLockedSplatPlyHeader, readLockedPlyPosition } from "@/lib/splats/ply-locked";
import {
  LOCKED_SPLAT_PLY_PROPERTIES,
  LOCKED_SPLAT_PLY_RECORD_BYTES,
  SPLAT_GAUSSIAN_SEMANTICS,
  SplatBounds,
  SplatTilesetDocument,
  SplatTilesetPresetName
} from "@/lib/splats/types";
import { putObjectToStorage } from "@/lib/storage/s3";

interface BuildSplatTilesetInput {
  sourceArtifactId: string;
  sourcePlyFilePath: string;
  projectSlug: string;
  presetName: SplatTilesetPresetName;
  localStorageRoot: string;
  maxOpenFiles?: number;
}

interface BuildSplatTilesetOutput {
  tileset: SplatTilesetDocument;
  tilesetLocalPath: string;
  tilesetStorageKey: string;
  tilesetByteSize: number;
  tilesetHash: string;
  prefixStorageKey: string;
}

interface TileCoords {
  ix: number;
  iy: number;
  iz: number;
}

interface TileStats {
  id: string;
  coords: TileCoords;
  bounds: SplatBounds;
  center: [number, number, number];
  radius: number;
  counts: [number, number, number];
}

class LruAppendFilePool {
  private readonly maxOpenFiles: number;
  private readonly openFiles = new Map<string, { handle: fs.FileHandle; tick: number }>();
  private tick = 0;

  constructor(maxOpenFiles: number) {
    this.maxOpenFiles = Math.max(8, Math.floor(maxOpenFiles));
  }

  async append(filePath: string, data: Buffer) {
    let entry = this.openFiles.get(filePath);
    if (!entry) {
      if (this.openFiles.size >= this.maxOpenFiles) {
        await this.evictOne();
      }
      const handle = await fs.open(filePath, "a");
      entry = { handle, tick: ++this.tick };
      this.openFiles.set(filePath, entry);
    } else {
      entry.tick = ++this.tick;
    }

    await entry.handle.write(data);
  }

  private async evictOne() {
    let oldestKey: string | null = null;
    let oldestTick = Number.POSITIVE_INFINITY;

    for (const [key, value] of this.openFiles.entries()) {
      if (value.tick < oldestTick) {
        oldestTick = value.tick;
        oldestKey = key;
      }
    }

    if (!oldestKey) return;
    const entry = this.openFiles.get(oldestKey);
    this.openFiles.delete(oldestKey);
    if (entry) {
      await entry.handle.close();
    }
  }

  async closeAll() {
    const closing = [...this.openFiles.values()].map((entry) => entry.handle.close());
    this.openFiles.clear();
    await Promise.allSettled(closing);
  }
}

function fnv1a32(input: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deterministicKeep(tileId: string, vertexIndex: number, ratio: number) {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const seed = fnv1a32(`${tileId}:${vertexIndex}`);
  const unit = seed / 0xffffffff;
  return unit <= ratio;
}

function getLocalStorageRoot(configured: string) {
  return configured?.trim() ? path.resolve(configured) : path.join(process.cwd(), ".local-storage");
}

function parseTileId(tileId: string): TileCoords {
  const [ixToken, iyToken, izToken] = tileId.split("_");
  return {
    ix: Number.parseInt(ixToken ?? "0", 10) || 0,
    iy: Number.parseInt(iyToken ?? "0", 10) || 0,
    iz: Number.parseInt(izToken ?? "0", 10) || 0
  };
}

function clampIndex(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computeGridRes(vertexCount: number, targetPerTile: number) {
  const estimatedTileCount = Math.max(1, Math.ceil(vertexCount / Math.max(1, targetPerTile)));
  return Math.max(1, Math.ceil(Math.cbrt(estimatedTileCount)));
}

function computeAxisExtent(min: number, max: number) {
  const extent = max - min;
  return extent > 0 ? extent : 1e-6;
}

function computeTileBounds(coords: TileCoords, worldBounds: SplatBounds, gridRes: number): SplatBounds {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];

  const axisCoords = [coords.ix, coords.iy, coords.iz];
  for (let axis = 0; axis < 3; axis += 1) {
    const worldMin = worldBounds.min[axis];
    const worldMax = worldBounds.max[axis];
    const extent = computeAxisExtent(worldMin, worldMax);
    const cellSize = extent / gridRes;
    min[axis] = worldMin + axisCoords[axis] * cellSize;
    max[axis] = axisCoords[axis] === gridRes - 1 ? worldMax : min[axis] + cellSize;
  }

  return { min, max };
}

function computeTileCenter(bounds: SplatBounds): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
}

function computeTileRadius(bounds: SplatBounds) {
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
}

function computeBaseTileCoords(position: [number, number, number], worldBounds: SplatBounds, gridRes: number): TileCoords {
  const coords: number[] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const worldMin = worldBounds.min[axis];
    const worldMax = worldBounds.max[axis];
    const extent = computeAxisExtent(worldMin, worldMax);
    const normalized = (position[axis] - worldMin) / extent;
    const idx = Math.floor(normalized * gridRes);
    coords[axis] = clampIndex(idx, 0, gridRes - 1);
  }
  return {
    ix: coords[0],
    iy: coords[1],
    iz: coords[2]
  };
}

function toBaseTileId(coords: TileCoords) {
  return `${coords.ix}_${coords.iy}_${coords.iz}`;
}

function toFinalTileId(baseId: string, shardIndex: number) {
  return shardIndex <= 0 ? baseId : `${baseId}_${shardIndex}`;
}

function makeStorageKey(input: {
  projectSlug: string;
  artifactId: string;
  presetName: SplatTilesetPresetName;
  relativePath: string;
}) {
  return `projects/${input.projectSlug}/splats/${input.artifactId}/tiles/${input.presetName}/${input.relativePath}`;
}

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function contentTypeForFile(relativePath: string) {
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".ply")) return "application/octet-stream";
  return "application/octet-stream";
}

export async function buildSplatTilesetFromPly(input: BuildSplatTilesetInput): Promise<BuildSplatTilesetOutput> {
  const preset = getSplatTilesetPreset(input.presetName);
  const localStorageRoot = getLocalStorageRoot(input.localStorageRoot);
  const header = await parseLockedSplatPlyHeader(input.sourcePlyFilePath);

  const worldBounds: SplatBounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  };

  await iterateLockedPlyRecords({
    filePath: input.sourcePlyFilePath,
    header,
    onRecord(record) {
      const [x, y, z] = readLockedPlyPosition(record);
      if (x < worldBounds.min[0]) worldBounds.min[0] = x;
      if (y < worldBounds.min[1]) worldBounds.min[1] = y;
      if (z < worldBounds.min[2]) worldBounds.min[2] = z;
      if (x > worldBounds.max[0]) worldBounds.max[0] = x;
      if (y > worldBounds.max[1]) worldBounds.max[1] = y;
      if (z > worldBounds.max[2]) worldBounds.max[2] = z;
    }
  });

  const gridRes = computeGridRes(header.vertexCount, preset.targetSplatsPerTile);
  const seenPerBase = new Map<string, number>();
  const tileStats = new Map<string, TileStats>();

  await iterateLockedPlyRecords({
    filePath: input.sourcePlyFilePath,
    header,
    onRecord(record, vertexIndex) {
      const position = readLockedPlyPosition(record);
      const coords = computeBaseTileCoords(position, worldBounds, gridRes);
      const baseId = toBaseTileId(coords);
      const seen = seenPerBase.get(baseId) ?? 0;
      const shard = Math.floor(seen / preset.maxTileSplats);
      seenPerBase.set(baseId, seen + 1);
      const tileId = toFinalTileId(baseId, shard);

      let stats = tileStats.get(tileId);
      if (!stats) {
        const tileCoords = parseTileId(baseId);
        const bounds = computeTileBounds(tileCoords, worldBounds, gridRes);
        stats = {
          id: tileId,
          coords: tileCoords,
          bounds,
          center: computeTileCenter(bounds),
          radius: computeTileRadius(bounds),
          counts: [0, 0, 0]
        };
        tileStats.set(tileId, stats);
      }

      stats.counts[0] += 1;
      if (deterministicKeep(tileId, vertexIndex, preset.lodRatios[1])) {
        stats.counts[1] += 1;
      }
      if (deterministicKeep(tileId, vertexIndex, preset.lodRatios[2])) {
        stats.counts[2] += 1;
      }
    }
  });

  const outputBaseLocalDir = path.join(
    localStorageRoot,
    "projects",
    input.projectSlug,
    "splats",
    input.sourceArtifactId,
    "tiles",
    input.presetName
  );
  await fs.mkdir(outputBaseLocalDir, { recursive: true });

  const lodFileMap = new Map<string, { localPath: string; relativePath: string }>();
  const lodTileEntries: Array<Array<{ tile: TileStats; url: string; byteSize: number; splatCount: number }>> = [
    [],
    [],
    []
  ];

  const sortedTiles = [...tileStats.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const tile of sortedTiles) {
    for (let lod = 0 as 0 | 1 | 2; lod < 3; lod = (lod + 1) as 0 | 1 | 2) {
      const splatCount = tile.counts[lod];
      if (splatCount <= 0) continue;

      const relativePath = `lod${lod}/${tile.id}.ply`;
      const localPath = path.join(outputBaseLocalDir, relativePath);
      await ensureDir(localPath);
      const headerBuffer = createLockedSplatPlyHeader(splatCount);
      await fs.writeFile(localPath, headerBuffer);

      lodFileMap.set(`${lod}:${tile.id}`, { localPath, relativePath });
      lodTileEntries[lod].push({
        tile,
        url: relativePath,
        byteSize: headerBuffer.byteLength + splatCount * LOCKED_SPLAT_PLY_RECORD_BYTES,
        splatCount
      });
    }
  }

  const seenPerBaseWrite = new Map<string, number>();
  const writerPool = new LruAppendFilePool(input.maxOpenFiles ?? 64);
  try {
    await iterateLockedPlyRecords({
      filePath: input.sourcePlyFilePath,
      header,
      async onRecord(record, vertexIndex) {
        const position = readLockedPlyPosition(record);
        const coords = computeBaseTileCoords(position, worldBounds, gridRes);
        const baseId = toBaseTileId(coords);
        const seen = seenPerBaseWrite.get(baseId) ?? 0;
        const shard = Math.floor(seen / preset.maxTileSplats);
        seenPerBaseWrite.set(baseId, seen + 1);
        const tileId = toFinalTileId(baseId, shard);

        const lod0 = lodFileMap.get(`0:${tileId}`);
        if (lod0) {
          await writerPool.append(lod0.localPath, record);
        }

        if (deterministicKeep(tileId, vertexIndex, preset.lodRatios[1])) {
          const lod1 = lodFileMap.get(`1:${tileId}`);
          if (lod1) await writerPool.append(lod1.localPath, record);
        }
        if (deterministicKeep(tileId, vertexIndex, preset.lodRatios[2])) {
          const lod2 = lodFileMap.get(`2:${tileId}`);
          if (lod2) await writerPool.append(lod2.localPath, record);
        }
      }
    });
  } finally {
    await writerPool.closeAll();
  }

  const lods: SplatTilesetDocument["lods"] = [0, 1, 2].map((lod) => ({
    level: lod as 0 | 1 | 2,
    targetSplatsPerTile: preset.targetSplatsPerTile,
    tiles: lodTileEntries[lod]
      .sort((a, b) => a.tile.id.localeCompare(b.tile.id))
      .map((entry) => ({
        id: entry.tile.id,
        bounds: entry.tile.bounds,
        center: entry.tile.center,
        radius: entry.tile.radius,
        splatCount: entry.splatCount,
        byteSize: entry.byteSize,
        url: entry.url
      }))
  }));

  const tileset: SplatTilesetDocument = {
    version: 1,
    sourceArtifactId: input.sourceArtifactId,
    format: "ply",
    plySchema: {
      format: "binary_little_endian",
      properties: LOCKED_SPLAT_PLY_PROPERTIES
    },
    gaussianSemantics: SPLAT_GAUSSIAN_SEMANTICS,
    bounds: worldBounds,
    preset: input.presetName,
    lods
  };

  const tilesetRelativePath = "tileset.json";
  const tilesetLocalPath = path.join(outputBaseLocalDir, tilesetRelativePath);
  const tilesetStorageKey = makeStorageKey({
    projectSlug: input.projectSlug,
    artifactId: input.sourceArtifactId,
    presetName: input.presetName,
    relativePath: tilesetRelativePath
  });
  const tilesetBuffer = Buffer.from(JSON.stringify(tileset, null, 2), "utf8");
  await fs.writeFile(tilesetLocalPath, tilesetBuffer);

  for (const [, file] of lodFileMap.entries()) {
    const body = await fs.readFile(file.localPath);
    const key = makeStorageKey({
      projectSlug: input.projectSlug,
      artifactId: input.sourceArtifactId,
      presetName: input.presetName,
      relativePath: file.relativePath
    });
    await putObjectToStorage({
      key,
      body,
      contentType: contentTypeForFile(file.relativePath)
    });
  }

  await putObjectToStorage({
    key: tilesetStorageKey,
    body: tilesetBuffer,
    contentType: "application/json"
  });

  return {
    tileset,
    tilesetLocalPath,
    tilesetStorageKey,
    tilesetByteSize: tilesetBuffer.byteLength,
    tilesetHash: createHash("sha256").update(tilesetBuffer).digest("hex"),
    prefixStorageKey: makeStorageKey({
      projectSlug: input.projectSlug,
      artifactId: input.sourceArtifactId,
      presetName: input.presetName,
      relativePath: ""
    }).replace(/\/+$/, "")
  };
}

