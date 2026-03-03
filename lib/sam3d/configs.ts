import { Dirent, promises as fs } from "fs";
import path from "path";

const DEFAULT_SAM3D_CONFIG = "hf";

function getSam3dRepoRoot() {
  return process.env.SAM3D_REPO_ROOT || path.join(process.cwd(), "models", "sam-3d-objects");
}

function getSam3dCheckpointsRoot() {
  return path.join(getSam3dRepoRoot(), "checkpoints");
}

export async function listSam3dConfigOptions() {
  const root = getSam3dCheckpointsRoot();
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [DEFAULT_SAM3D_CONFIG];
  }

  const configs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pipelinePath = path.join(root, entry.name, "pipeline.yaml");
    try {
      await fs.access(pipelinePath);
      configs.push(entry.name);
    } catch {
      // Skip folders without pipeline yaml.
    }
  }

  const sorted = Array.from(new Set(configs)).sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return [DEFAULT_SAM3D_CONFIG];
  if (!sorted.includes(DEFAULT_SAM3D_CONFIG)) return [DEFAULT_SAM3D_CONFIG, ...sorted];
  return [DEFAULT_SAM3D_CONFIG, ...sorted.filter((name) => name !== DEFAULT_SAM3D_CONFIG)];
}

export async function resolveSam3dConfigName(selected: string | null | undefined) {
  const requested = (selected ?? "").trim();
  const options = await listSam3dConfigOptions();
  if (requested && options.includes(requested)) return requested;
  return options[0] ?? DEFAULT_SAM3D_CONFIG;
}

export function getDefaultSam3dConfig() {
  return DEFAULT_SAM3D_CONFIG;
}
