import { SplatTilesetPreset, SplatTilesetPresetName } from "@/lib/splats/types";

const PRESETS: Record<SplatTilesetPresetName, SplatTilesetPreset> = {
  Default: {
    name: "Default",
    targetSplatsPerTile: 250_000,
    maxTileSplats: 500_000,
    lodRatios: [1, 0.25, 0.0625]
  },
  HighQuality: {
    name: "HighQuality",
    targetSplatsPerTile: 150_000,
    maxTileSplats: 400_000,
    lodRatios: [1, 0.35, 0.1]
  },
  FastPreview: {
    name: "FastPreview",
    targetSplatsPerTile: 400_000,
    maxTileSplats: 700_000,
    lodRatios: [1, 0.15, 0.04]
  }
};

export const SPLAT_TILESET_PRESET_NAMES = Object.keys(PRESETS) as SplatTilesetPresetName[];

export function parseSplatTilesetPresetName(value: unknown): SplatTilesetPresetName {
  if (typeof value !== "string") return "Default";
  if (value === "Default" || value === "HighQuality" || value === "FastPreview") {
    return value;
  }
  return "Default";
}

export function getSplatTilesetPreset(name: SplatTilesetPresetName): SplatTilesetPreset {
  return PRESETS[name] ?? PRESETS.Default;
}

