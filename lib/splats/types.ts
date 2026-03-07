export const LOCKED_SPLAT_PLY_PROPERTIES = [
  "x",
  "y",
  "z",
  "nx",
  "ny",
  "nz",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3"
] as const;

export type LockedSplatPlyProperty = (typeof LOCKED_SPLAT_PLY_PROPERTIES)[number];

export const LOCKED_SPLAT_PLY_FLOATS_PER_VERTEX = 17;
export const LOCKED_SPLAT_PLY_RECORD_BYTES = LOCKED_SPLAT_PLY_FLOATS_PER_VERTEX * 4;

export const SPLAT_GAUSSIAN_SEMANTICS = {
  color: "sh_dc",
  opacity: "logit",
  scale: "log",
  rotation: "quat_xyzw"
} as const;

export type SplatTilesetPresetName = "Default" | "HighQuality" | "FastPreview";

export interface SplatTilesetPreset {
  name: SplatTilesetPresetName;
  targetSplatsPerTile: number;
  maxTileSplats: number;
  lodRatios: [number, number, number];
}

export interface SplatBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SplatTilesetTileEntry {
  id: string;
  bounds: SplatBounds;
  center: [number, number, number];
  radius: number;
  splatCount: number;
  byteSize: number;
  url: string;
}

export interface SplatTilesetLodEntry {
  level: 0 | 1 | 2;
  targetSplatsPerTile: number;
  tiles: SplatTilesetTileEntry[];
}

export interface SplatTilesetDocument {
  version: 1;
  sourceArtifactId: string;
  format: "ply";
  plySchema: {
    format: "binary_little_endian";
    properties: readonly LockedSplatPlyProperty[];
  };
  gaussianSemantics: typeof SPLAT_GAUSSIAN_SEMANTICS;
  bounds: SplatBounds;
  preset: SplatTilesetPresetName;
  lods: SplatTilesetLodEntry[];
}

