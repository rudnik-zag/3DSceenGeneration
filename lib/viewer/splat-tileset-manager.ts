"use client";

import * as THREE from "three";

import { SplatTilesetDocument, SplatTilesetTileEntry } from "@/lib/splats/types";

export interface RuntimeSplatTile extends SplatTilesetTileEntry {
  level: 0 | 1 | 2;
  key: string;
  absoluteUrl: string;
}

interface TileVariantGroup {
  id: string;
  variants: RuntimeSplatTile[];
}

interface LoadedTile {
  tile: RuntimeSplatTile;
  handle: unknown;
  priority: number;
}

interface LoadingTile {
  tile: RuntimeSplatTile;
  abortController: AbortController;
  promise: Promise<void>;
}

export interface SplatTilesetManagerStats {
  visibleTiles: number;
  loadedTiles: number;
  loadedSplats: number;
  loadedMB: number;
  activeLodDistribution: Record<"0" | "1" | "2", number>;
}

interface SplatTilesetManagerOptions {
  maxLoadedSplats?: number;
  maxLoadedMB?: number;
  maxConcurrentLoads?: number;
  lodUpdateEveryNFrames?: number;
  hysteresisFactor?: number;
  onLoadTile: (tile: RuntimeSplatTile, signal: AbortSignal) => Promise<unknown>;
  onUnloadTile: (tile: RuntimeSplatTile, handle: unknown) => Promise<void> | void;
  onStats?: (stats: SplatTilesetManagerStats) => void;
}

export class SplatTilesetManager {
  private readonly options: Required<
    Pick<
      SplatTilesetManagerOptions,
      "maxLoadedSplats" | "maxLoadedMB" | "maxConcurrentLoads" | "lodUpdateEveryNFrames" | "hysteresisFactor"
    >
  > &
    Pick<SplatTilesetManagerOptions, "onLoadTile" | "onUnloadTile" | "onStats">;

  private tilesetUrl: string | null = null;
  private tileset: SplatTilesetDocument | null = null;
  private groups: TileVariantGroup[] = [];
  private frameCounter = 0;

  private readonly loaded = new Map<string, LoadedTile>();
  private readonly loading = new Map<string, LoadingTile>();

  private loadedSplats = 0;
  private loadedBytes = 0;

  constructor(options: SplatTilesetManagerOptions) {
    this.options = {
      maxLoadedSplats: options.maxLoadedSplats ?? 5_000_000,
      maxLoadedMB: options.maxLoadedMB ?? 1500,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
      lodUpdateEveryNFrames: options.lodUpdateEveryNFrames ?? 10,
      hysteresisFactor: options.hysteresisFactor ?? 0.18,
      onLoadTile: options.onLoadTile,
      onUnloadTile: options.onUnloadTile,
      onStats: options.onStats
    };
  }

  async loadTileset(tilesetUrl: string) {
    if (this.tilesetUrl === tilesetUrl && this.tileset) return;
    await this.reset();

    const response = await fetch(tilesetUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load tileset.json (${response.status})`);
    }
    const raw = (await response.json()) as SplatTilesetDocument;
    this.validateTileset(raw);

    this.tilesetUrl = tilesetUrl;
    this.tileset = raw;
    this.groups = this.buildGroups(raw, tilesetUrl);
  }

  private validateTileset(tileset: SplatTilesetDocument) {
    if (tileset.format !== "ply") {
      throw new Error(`Unsupported tileset format "${String(tileset.format)}".`);
    }
    if (!Array.isArray(tileset.lods) || tileset.lods.length === 0) {
      throw new Error("Invalid tileset: missing lod entries.");
    }
  }

  private buildGroups(tileset: SplatTilesetDocument, tilesetUrl: string) {
    const grouped = new Map<string, RuntimeSplatTile[]>();

    for (const lod of tileset.lods) {
      for (const tile of lod.tiles) {
        const key = `${lod.level}:${tile.id}`;
        const absoluteUrl = new URL(tile.url, tilesetUrl).toString();
        const runtimeTile: RuntimeSplatTile = {
          ...tile,
          level: lod.level,
          key,
          absoluteUrl
        };
        const existing = grouped.get(tile.id) ?? [];
        existing.push(runtimeTile);
        grouped.set(tile.id, existing);
      }
    }

    return [...grouped.entries()]
      .map(([id, variants]) => ({
        id,
        variants: variants.sort((a, b) => a.level - b.level)
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private projectedRadiusPixels(camera: THREE.PerspectiveCamera, radius: number, distance: number, viewportHeight: number) {
    const safeDistance = Math.max(1e-6, distance);
    const fovRad = (camera.fov * Math.PI) / 180;
    const pixelsPerUnit = viewportHeight / (2 * Math.tan(fovRad / 2));
    return (radius / safeDistance) * pixelsPerUnit;
  }

  private chooseLod(group: TileVariantGroup, camera: THREE.PerspectiveCamera, viewportHeight: number, frustum: THREE.Frustum) {
    const lod0 = group.variants.find((variant) => variant.level === 0) ?? group.variants[0];
    const center = new THREE.Vector3(...lod0.center);
    const sphere = new THREE.Sphere(center, lod0.radius);
    if (!frustum.intersectsSphere(sphere)) {
      return null;
    }

    const distance = camera.position.distanceTo(center);
    const projected = this.projectedRadiusPixels(camera, lod0.radius, distance, viewportHeight);

    let desiredLod: 0 | 1 | 2 = 2;
    if (projected > 220) desiredLod = 0;
    else if (projected > 90) desiredLod = 1;

    const loadedForGroup = group.variants.find((variant) => this.loaded.has(variant.key)) ?? null;
    if (loadedForGroup) {
      const delta = Math.abs(loadedForGroup.level - desiredLod);
      if (delta > 0 && projected > 0) {
        const holdThreshold = projected * this.options.hysteresisFactor;
        const step = desiredLod < loadedForGroup.level ? -1 : 1;
        const adjusted = projected + step * holdThreshold;
        if (loadedForGroup.level === 0 && adjusted > 180) desiredLod = 0;
        if (loadedForGroup.level === 1 && adjusted > 70 && adjusted <= 260) desiredLod = 1;
      }
    }

    const variant = group.variants.find((entry) => entry.level === desiredLod) ?? group.variants[group.variants.length - 1];
    const priority = projected / Math.max(distance, 1e-3);
    return { variant, priority };
  }

  private buildStats(visibleTiles: number): SplatTilesetManagerStats {
    const distribution: Record<"0" | "1" | "2", number> = { "0": 0, "1": 0, "2": 0 };
    for (const value of this.loaded.values()) {
      distribution[String(value.tile.level) as "0" | "1" | "2"] += 1;
    }
    return {
      visibleTiles,
      loadedTiles: this.loaded.size,
      loadedSplats: this.loadedSplats,
      loadedMB: this.loadedBytes / (1024 * 1024),
      activeLodDistribution: distribution
    };
  }

  private async unloadKey(key: string) {
    const loaded = this.loaded.get(key);
    if (!loaded) return;
    this.loaded.delete(key);
    this.loadedSplats -= loaded.tile.splatCount;
    this.loadedBytes -= loaded.tile.byteSize;
    await this.options.onUnloadTile(loaded.tile, loaded.handle);
  }

  private async enforceBudgets() {
    const maxBytes = this.options.maxLoadedMB * 1024 * 1024;
    if (this.loadedSplats <= this.options.maxLoadedSplats && this.loadedBytes <= maxBytes) {
      return;
    }

    const sorted = [...this.loaded.values()].sort((a, b) => a.priority - b.priority);
    for (const entry of sorted) {
      if (this.loadedSplats <= this.options.maxLoadedSplats && this.loadedBytes <= maxBytes) break;
      await this.unloadKey(entry.tile.key);
    }
  }

  async update(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    if (!this.tileset || this.groups.length === 0) return;
    this.frameCounter += 1;
    if (this.frameCounter % this.options.lodUpdateEveryNFrames !== 0) return;

    const frustum = new THREE.Frustum();
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix);

    const desired = new Map<string, { tile: RuntimeSplatTile; priority: number }>();

    for (const group of this.groups) {
      const picked = this.chooseLod(group, camera, viewportHeight, frustum);
      if (!picked) continue;
      desired.set(picked.variant.key, { tile: picked.variant, priority: picked.priority });
    }

    for (const [key, loading] of this.loading.entries()) {
      if (!desired.has(key)) {
        loading.abortController.abort();
        this.loading.delete(key);
      }
    }

    for (const [key, loaded] of this.loaded.entries()) {
      if (!desired.has(key)) {
        await this.unloadKey(key);
      } else {
        loaded.priority = desired.get(key)?.priority ?? loaded.priority;
      }
    }

    await this.enforceBudgets();

    const toLoad = [...desired.values()]
      .filter((entry) => !this.loaded.has(entry.tile.key) && !this.loading.has(entry.tile.key))
      .sort((a, b) => b.priority - a.priority);

    const maxBytes = this.options.maxLoadedMB * 1024 * 1024;
    for (const entry of toLoad) {
      if (this.loading.size >= this.options.maxConcurrentLoads) break;
      const projectedSplats = this.loadedSplats + entry.tile.splatCount;
      const projectedBytes = this.loadedBytes + entry.tile.byteSize;
      if (projectedSplats > this.options.maxLoadedSplats || projectedBytes > maxBytes) {
        continue;
      }

      const abortController = new AbortController();
      const loading: LoadingTile = {
        tile: entry.tile,
        abortController,
        promise: this.options
          .onLoadTile(entry.tile, abortController.signal)
          .then((handle) => {
            this.loading.delete(entry.tile.key);
            if (abortController.signal.aborted) {
              void this.options.onUnloadTile(entry.tile, handle);
              return;
            }
            this.loaded.set(entry.tile.key, {
              tile: entry.tile,
              handle,
              priority: entry.priority
            });
            this.loadedSplats += entry.tile.splatCount;
            this.loadedBytes += entry.tile.byteSize;
          })
          .catch(() => {
            this.loading.delete(entry.tile.key);
          })
      };
      this.loading.set(entry.tile.key, loading);
    }

    this.options.onStats?.(this.buildStats(desired.size));
  }

  async reset() {
    for (const loading of this.loading.values()) {
      loading.abortController.abort();
    }
    this.loading.clear();

    const loadedEntries = [...this.loaded.entries()];
    for (const [key] of loadedEntries) {
      await this.unloadKey(key);
    }

    this.loaded.clear();
    this.loadedSplats = 0;
    this.loadedBytes = 0;
    this.tileset = null;
    this.tilesetUrl = null;
    this.groups = [];
    this.frameCounter = 0;
  }
}

