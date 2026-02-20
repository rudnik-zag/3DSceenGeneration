"use client";

export interface SplatLoadResult {
  dispose: () => void;
  warning?: string;
}

export async function loadSplatPlaceholder(
  _url: string,
  _scene: unknown
): Promise<SplatLoadResult> {
  return {
    warning: "Splat renderer hook is ready. Plug in ksplat/spz runtime later.",
    dispose: () => {
      // reserved for real splat renderer cleanup
    }
  };
}
