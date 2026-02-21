import { createHash } from "crypto";

import { WorkflowNodeType } from "@/types/workflow";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashString(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

export function makeCacheKey(
  nodeType: WorkflowNodeType,
  params: Record<string, unknown>,
  orderedInputArtifactHashes: string[],
  mode?: string
) {
  const raw = [nodeType, stableStringify(params), orderedInputArtifactHashes.join("|"), mode ?? "default"].join("::");
  return hashString(raw);
}

export function makeOutputCacheKey(baseCacheKey: string, outputId: string) {
  return hashString(`${baseCacheKey}::${outputId}`);
}
