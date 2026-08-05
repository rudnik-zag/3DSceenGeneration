"use client";

export interface SplatLoadResult {
  dispose: () => void;
  warning?: string;
}

export async function loadSplatPlaceholder(
  url: string,
  scene: unknown
): Promise<SplatLoadResult> {
  void url;
  void scene;
  return {
    warning: "Splat renderer hook is ready. Plug in ksplat/spz runtime later.",
    dispose: () => {
      // reserved for real splat renderer cleanup
    }
  };
}
