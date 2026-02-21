import { createHash } from "crypto";

import { ArtifactKind } from "@prisma/client";

import { NodeExecutionContext, NodeExecutionResult, NodeExecutor } from "@/lib/execution/contracts";
import { executeGroundingDinoNode } from "@/lib/execution/executors/groundingdino";
import { executeSam2Node } from "@/lib/execution/executors/sam2";
import {
  createGeneratedImageSvgBuffer,
  createJsonBuffer,
  createMinimalGlbBuffer,
  createPointCloudPlyBuffer,
  ONE_PIXEL_PNG
} from "@/lib/execution/mock-assets";
import { getObjectBuffer } from "@/lib/storage/s3";
import { WorkflowNodeType } from "@/types/workflow";

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function jsonOutput(outputId: string, data: Record<string, unknown>, hidden = false) {
  const buffer = createJsonBuffer(data);
  return {
    outputId,
    kind: "json" as ArtifactKind,
    mimeType: "application/json",
    extension: "json",
    hidden,
    buffer,
    meta: {
      outputKey: outputId,
      hidden
    }
  };
}

export class MockModelRunner implements NodeExecutor {
  async executeNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const now = new Date().toISOString();

    switch (ctx.nodeType) {
      case "model.groundingdino":
        return executeGroundingDinoNode(ctx);
      case "model.sam2":
        return executeSam2Node(ctx);
      case "input.image": {
        const sourceMode = ctx.params.sourceMode === "generate" ? "generate" : "upload";
        if (sourceMode === "generate") {
          const model = typeof ctx.params.generatorModel === "string" && ctx.params.generatorModel.trim() ? ctx.params.generatorModel.trim() : "Z-Image-Turbo";
          const prompt = typeof ctx.params.prompt === "string" ? ctx.params.prompt : "";
          await new Promise((resolve) => setTimeout(resolve, 1100));
          const generated = createGeneratedImageSvgBuffer({ model, prompt });
          return {
            outputs: [
              {
                outputId: "image",
                kind: "image",
                mimeType: "image/svg+xml",
                extension: "svg",
                buffer: generated,
                preview: {
                  extension: "svg",
                  mimeType: "image/svg+xml",
                  buffer: generated
                },
                meta: {
                  outputKey: "image",
                  source: "mock-generate",
                  model,
                  prompt,
                  createdAt: now
                },
                hidden: false
              }
            ]
          };
        }

        const sourceKey = typeof ctx.params.storageKey === "string" ? ctx.params.storageKey : "";
        const source = sourceKey ? await getObjectBuffer(sourceKey).catch(() => ONE_PIXEL_PNG) : ONE_PIXEL_PNG;
        return {
          outputs: [
            {
              outputId: "image",
              kind: "image",
              mimeType: "image/png",
              extension: "png",
              buffer: source,
              preview: {
                extension: "png",
                mimeType: "image/png",
                buffer: source
              },
              meta: {
                outputKey: "image",
                source: "mock-upload",
                createdAt: now,
                filename: ctx.params.filename ?? "image.png",
                sourceStorageKey: sourceKey
              },
              hidden: false
            }
          ]
        };
      }
      case "input.text":
        return {
          outputs: [jsonOutput("text", { type: "text", value: ctx.params.value ?? "", createdAt: now })]
        };
      case "input.cameraPath":
        return {
          outputs: [jsonOutput("path", { type: "camera_path", value: ctx.params.json ?? "[]", createdAt: now })]
        };
      case "model.sam3d_objects":
        return {
          outputs: [jsonOutput("json", { objects: [{ id: "obj_1", confidence: 0.82 }], createdAt: now })]
        };
      case "model.qwen_vl":
        return {
          outputs: [jsonOutput("json", { summary: "Mock VLM analysis output", createdAt: now })]
        };
      case "model.qwen_image_edit": {
        const hash = hashBuffer(ONE_PIXEL_PNG);
        return {
          outputs: [
            {
              outputId: "image",
              kind: "image",
              mimeType: "image/png",
              extension: "png",
              buffer: ONE_PIXEL_PNG,
              preview: {
                extension: "png",
                mimeType: "image/png",
                buffer: ONE_PIXEL_PNG
              },
              meta: { outputKey: "image", prompt: ctx.params.prompt ?? "", createdAt: now },
              hidden: false
            }
          ]
        };
      }
      case "geo.depth_estimation": {
        const hash = hashBuffer(ONE_PIXEL_PNG);
        return {
          outputs: [
            {
              outputId: "depth",
              kind: "image",
              mimeType: "image/png",
              extension: "png",
              buffer: ONE_PIXEL_PNG,
              preview: {
                extension: "png",
                mimeType: "image/png",
                buffer: ONE_PIXEL_PNG
              },
              meta: { outputKey: "depth", semantic: "depth", createdAt: now, hash },
              hidden: false
            }
          ]
        };
      }
      case "geo.pointcloud_from_depth": {
        const buffer = createPointCloudPlyBuffer();
        return {
          outputs: [
            {
              outputId: "pointcloud",
              kind: "point_ply",
              mimeType: "application/octet-stream",
              extension: "ply",
              buffer,
              meta: { outputKey: "pointcloud", points: 8, createdAt: now },
              hidden: false
            }
          ]
        };
      }
      case "geo.mesh_reconstruction":
      case "geo.uv_unwrap": {
        const buffer = createMinimalGlbBuffer();
        return {
          outputs: [
            {
              outputId: "mesh",
              kind: "mesh_glb",
              mimeType: "model/gltf-binary",
              extension: "glb",
              buffer,
              meta: { outputKey: "mesh", createdAt: now },
              hidden: false
            }
          ]
        };
      }
      case "geo.bake_textures":
        return {
          outputs: [jsonOutput("textures", { textures: ["albedo", "normal"], createdAt: now })]
        };
      case "out.export_scene": {
        const format = (ctx.params.format as string | undefined) ?? "mesh_glb";
        if (format === "point_ply") {
          const buffer = createPointCloudPlyBuffer();
          return {
            outputs: [
              {
                outputId: "scene",
                kind: "point_ply",
                mimeType: "application/octet-stream",
                extension: "ply",
                buffer,
                meta: { outputKey: "scene", points: 8, exporter: "mock", createdAt: now },
                hidden: false
              }
            ]
          };
        }
        if (format === "splat_ksplat") {
          const buffer = Buffer.from("ksplat placeholder\n", "utf8");
          return {
            outputs: [
              {
                outputId: "scene",
                kind: "splat_ksplat",
                mimeType: "application/octet-stream",
                extension: "ksplat",
                buffer,
                meta: { outputKey: "scene", stub: true, exporter: "mock", createdAt: now },
                hidden: false
              }
            ]
          };
        }

        const buffer = createMinimalGlbBuffer();
        return {
          outputs: [
            {
              outputId: "scene",
              kind: "mesh_glb",
              mimeType: "model/gltf-binary",
              extension: "glb",
              buffer,
              meta: { outputKey: "scene", exporter: "mock", compression: "none", createdAt: now },
              hidden: false
            }
          ]
        };
      }
      case "out.open_in_viewer":
        return {
          outputs: [jsonOutput("json", { route: `/app/p/${ctx.projectId}/viewer`, createdAt: now })]
        };
      default:
        return {
          outputs: [jsonOutput("json", { warning: `No mock for ${ctx.nodeType}`, createdAt: now })]
        };
    }
  }
}

export function stableHashForOutput(buffer: Buffer) {
  return hashBuffer(buffer);
}
