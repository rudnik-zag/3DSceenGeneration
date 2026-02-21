import { createHash } from "crypto";

import { NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";
import { buildDetectionOverlaySvg, buildMaskSvg, NormalizedBox } from "@/lib/execution/executors/svg";

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function parseBoxes(payload: unknown): NormalizedBox[] {
  if (!payload || typeof payload !== "object") return [];
  const maybeBoxes = (payload as { boxes?: unknown }).boxes;
  if (!Array.isArray(maybeBoxes)) return [];

  const boxes: NormalizedBox[] = [];
  for (const item of maybeBoxes) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (!Array.isArray(obj.bbox) || obj.bbox.length !== 4) continue;
    const coords = obj.bbox.map((n) => Number(n));
    if (coords.some((n) => !Number.isFinite(n))) continue;
    boxes.push({
      label: typeof obj.label === "string" ? obj.label : "object",
      score: Number.isFinite(obj.score) ? Number(obj.score) : 0.6,
      bbox: [coords[0], coords[1], coords[2], coords[3]]
    });
  }
  return boxes;
}

export async function executeSam2Node(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const imageInput = ctx.inputs.image?.[0];
  if (!imageInput) {
    throw new Error("SAM2 requires an image input");
  }

  const boxesInput = ctx.inputs.boxes?.[0];
  const mode = ctx.mode === "guided" || boxesInput ? "guided" : "full";
  const warnings = ctx.warnings ?? [];
  const threshold =
    typeof ctx.params.threshold === "number" && Number.isFinite(ctx.params.threshold) ? ctx.params.threshold : 0.5;

  let boxes: NormalizedBox[] = [];
  if (boxesInput) {
    try {
      const buffer = await ctx.loadInputBuffer(boxesInput);
      boxes = parseBoxes(JSON.parse(buffer.toString("utf8")));
    } catch {
      boxes = [];
    }
  }

  const maskBuffer = Buffer.from(
    buildMaskSvg({
      mode,
      boxes
    }),
    "utf8"
  );

  const overlayBuffer = Buffer.from(
    buildDetectionOverlaySvg({
      title: `SAM2 • ${mode === "guided" ? "Guided segmentation" : "Full segmentation"}`,
      boxes: boxes.length > 0 ? boxes : [{ label: "segment", score: 0.8, bbox: [0.18, 0.17, 0.5, 0.46] }]
    }),
    "utf8"
  );

  const metaPayload = {
    model: "sam2-mock",
    mode,
    threshold,
    warnings,
    sourceImageArtifactId: imageInput.artifactId,
    sourceImageHash: imageInput.hash,
    boxesArtifactId: boxesInput?.artifactId ?? null,
    boxesCount: boxes.length,
    createdAt: new Date().toISOString()
  };
  const metaBuffer = createJsonBuffer(metaPayload);
  const maskHash = hashBuffer(maskBuffer);
  const overlayHash = hashBuffer(overlayBuffer);
  const metaHash = hashBuffer(metaBuffer);

  const outputs = [
    {
      outputId: "mask",
      kind: "mask" as const,
      mimeType: "image/svg+xml",
      extension: "svg",
      buffer: maskBuffer,
      preview: {
        extension: "svg",
        mimeType: "image/svg+xml",
        buffer: maskBuffer
      },
      meta: {
        outputKey: "mask",
        mode,
        threshold,
        sourceImageArtifactId: imageInput.artifactId,
        sourceImageHash: imageInput.hash,
        boxesArtifactId: boxesInput?.artifactId ?? null,
        boxesCount: boxes.length,
        contentHash: maskHash
      }
    },
    {
      outputId: "overlay",
      kind: "image" as const,
      mimeType: "image/svg+xml",
      extension: "svg",
      buffer: overlayBuffer,
      preview: {
        extension: "svg",
        mimeType: "image/svg+xml",
        buffer: overlayBuffer
      },
      meta: {
        outputKey: "overlay",
        mode,
        sourceImageArtifactId: imageInput.artifactId,
        sourceImageHash: imageInput.hash,
        contentHash: overlayHash
      }
    },
    {
      outputId: "meta",
      kind: "json" as const,
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: metaBuffer,
      meta: {
        outputKey: "meta",
        hidden: true,
        mode,
        threshold,
        warnings,
        contentHash: metaHash
      }
    }
  ];

  return {
    mode,
    warnings,
    outputs
  };
}
