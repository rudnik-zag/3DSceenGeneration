import { promises as fs } from "fs";
import path from "path";

import { env } from "@/lib/env";

const DEFAULT_SAM2_CFG = "sam2.1_hiera_l.yaml";

function normalizeSlashes(value: string) {
  return value.replace(/\\/g, "/");
}

function getSam2RepoRoot() {
  return env.SAM2_REPO_ROOT || path.join(process.cwd(), "models", "sam2");
}

function getSam2ConfigsRoot() {
  return path.join(getSam2RepoRoot(), "sam2", "configs");
}

async function collectYamlFiles(dir: string, sink: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectYamlFiles(next, sink);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".yaml")) {
      sink.push(next);
    }
  }
}

export async function listSam2ConfigOptions() {
  const configsRoot = getSam2ConfigsRoot();
  const files: string[] = [];
  try {
    await collectYamlFiles(configsRoot, files);
  } catch {
    return [DEFAULT_SAM2_CFG];
  }

  const basenames = Array.from(new Set(files.map((file) => path.basename(file)))).sort((a, b) =>
    a.localeCompare(b)
  );

  if (!basenames.includes(DEFAULT_SAM2_CFG)) {
    return [DEFAULT_SAM2_CFG, ...basenames];
  }

  return [DEFAULT_SAM2_CFG, ...basenames.filter((name) => name !== DEFAULT_SAM2_CFG)];
}

export async function resolveSam2ConfigPath(selectedCfg: string | null | undefined) {
  const safeSelected = (selectedCfg ?? "").trim();
  const requested = safeSelected.length > 0 ? safeSelected : DEFAULT_SAM2_CFG;
  const configsRoot = getSam2ConfigsRoot();
  const exactRelative = normalizeSlashes(requested);
  const sam21Path = path.join(configsRoot, "sam2.1", path.basename(requested));

  const candidates = [
    path.join(configsRoot, exactRelative),
    sam21Path
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return {
        absolutePath: candidate,
        relativeToSam2Root: normalizeSlashes(path.relative(path.join(getSam2RepoRoot(), "sam2"), candidate))
      };
    } catch {
      // Try next candidate.
    }
  }

  const allConfigs = await listSam2ConfigOptions();
  const fallback = allConfigs.includes(DEFAULT_SAM2_CFG) ? DEFAULT_SAM2_CFG : allConfigs[0] ?? DEFAULT_SAM2_CFG;
  const fallbackAbs = path.join(configsRoot, "sam2.1", fallback);

  return {
    absolutePath: fallbackAbs,
    relativeToSam2Root: normalizeSlashes(path.relative(path.join(getSam2RepoRoot(), "sam2"), fallbackAbs))
  };
}

export function getDefaultSam2Config() {
  return DEFAULT_SAM2_CFG;
}

