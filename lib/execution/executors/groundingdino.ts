import { createHash } from "crypto";

import { ExecutorOutputArtifact, NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";
import { createJsonBuffer } from "@/lib/execution/mock-assets";
import { buildDetectionOverlaySvg, NormalizedBox } from "@/lib/execution/executors/svg";

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function deriveBoxes(sourceHash: string, prompt: string): NormalizedBox[] {
  const labels = prompt
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const seed = parseInt(sourceHash.slice(0, 8), 16) || 42;
  const count = Math.max(1, Math.min(3, labels.length || 2));
  const boxes: NormalizedBox[] = [];

  for (let i = 0; i < count; i += 1) {
    const offset = (seed % 97) / 1000 + i * 0.04;
    boxes.push({
      label: labels[i] ?? `object-${i + 1}`,
      score: Math.max(0.52, 0.92 - i * 0.08),
      bbox: [
        Math.min(0.72, 0.08 + i * 0.18 + offset),
        Math.min(0.62, 0.11 + i * 0.15),
        Math.max(0.16, 0.31 - i * 0.03),
        Math.max(0.16, 0.26 - i * 0.02)
      ]
    });
  }

  return boxes;
}

export async function executeGroundingDinoNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const sourceImage = ctx.inputs.image?.[0];
  if (!sourceImage) {
    throw new Error("GroundingDINO requires an image input");
  }

  const prompt = typeof ctx.params.prompt === "string" ? ctx.params.prompt : "person, object";
  const threshold =
    typeof ctx.params.threshold === "number" && Number.isFinite(ctx.params.threshold) ? ctx.params.threshold : 0.35;
  const boxes = deriveBoxes(sourceImage.hash, prompt);
  const now = new Date().toISOString();

  const boxesPayload = {
    model: "groundingdino-mock",
    threshold,
    prompt,
    createdAt: now,
    sourceImageArtifactId: sourceImage.artifactId,
    sourceImageHash: sourceImage.hash,
    boxes
  };

  const boxesBuffer = createJsonBuffer(boxesPayload);
  const overlayBuffer = Buffer.from(
    buildDetectionOverlaySvg({
      title: `GroundingDINO • ${prompt}`,
      boxes
    }),
    "utf8"
  );

  const outputs: ExecutorOutputArtifact[] = [
    {
      outputId: "boxes",
      kind: "json",
      mimeType: "application/json",
      extension: "json",
      hidden: true,
      buffer: boxesBuffer,
      meta: {
        outputKey: "boxes",
        hidden: true,
        sourceImageArtifactId: sourceImage.artifactId,
        sourceImageHash: sourceImage.hash,
        boxesCount: boxes.length,
        prompt,
        threshold
      }
    },
    {
      outputId: "overlay",
      kind: "image",
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
        sourceImageArtifactId: sourceImage.artifactId,
        sourceImageHash: sourceImage.hash,
        prompt,
        threshold,
        boxesCount: boxes.length
      }
    }
  ];

  for (const output of outputs) {
    if (!output.meta) output.meta = {};
    output.meta.contentHash = hashBuffer(output.buffer);
  }

  return {
    mode: "detection",
    outputs
  };
}
