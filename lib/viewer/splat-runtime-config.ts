export type SplatRuntimePreference = "auto" | "spark" | "legacy";

function normalizeRuntimePreference(rawValue: string | undefined): SplatRuntimePreference {
  const value = (rawValue ?? "").trim().toLowerCase();
  if (value === "spark" || value === "legacy" || value === "auto") {
    return value;
  }
  return "auto";
}

export function getSplatRuntimePreference(rawValue = process.env.NEXT_PUBLIC_SPLAT_RUNTIME): SplatRuntimePreference {
  return normalizeRuntimePreference(rawValue);
}

export function isSparkRuntimeEnabled(rawValue = process.env.NEXT_PUBLIC_SPARK_ENABLED): boolean {
  if (rawValue === undefined) return true;
  const normalized = rawValue.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}
