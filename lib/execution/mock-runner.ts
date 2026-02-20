import { createHash } from "crypto";

import { ArtifactKind } from "@prisma/client";

import {
  createJsonBuffer,
  createMinimalGlbBuffer,
  createPointCloudPlyBuffer,
  ONE_PIXEL_PNG
} from "@/lib/execution/mock-assets";
import { getObjectBuffer } from "@/lib/storage/s3";
import { WorkflowNodeType } from "@/types/workflow";

export interface MockRunnerContext {
  projectId: string;
  runId: string;
  nodeId: string;
  nodeType: WorkflowNodeType;
  params: Record<string, unknown>;
  dependencyArtifacts: Array<{ id: string; hash: string; kind: ArtifactKind }>;
}

export interface MockArtifact {
  kind: ArtifactKind;
  mimeType: string;
  extension: string;
  buffer: Buffer;
  meta?: Record<string, unknown>;
  preview?: {
    extension: string;
    mimeType: string;
    buffer: Buffer;
  };
  hash: string;
}

function hashBuffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function jsonArtifact(data: Record<string, unknown>, extra?: Partial<MockArtifact>): MockArtifact {
  const buffer = createJsonBuffer(data);
  return {
    kind: "json",
    mimeType: "application/json",
    extension: "json",
    buffer,
    hash: hashBuffer(buffer),
    ...extra
  };
}

export class MockModelRunner {
  async runNode(ctx: MockRunnerContext): Promise<MockArtifact> {
    const now = new Date().toISOString();

    switch (ctx.nodeType) {
      case "input.image": {
        const sourceKey = typeof ctx.params.storageKey === "string" ? ctx.params.storageKey : "";
        const source = sourceKey ? await getObjectBuffer(sourceKey).catch(() => ONE_PIXEL_PNG) : ONE_PIXEL_PNG;
        const hash = hashBuffer(source);
        return {
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          buffer: source,
          preview: {
            extension: "png",
            mimeType: "image/png",
            buffer: source
          },
          meta: { source: "mock-upload", createdAt: now, filename: ctx.params.filename ?? "image.png" },
          hash
        };
      }
      case "input.text":
        return jsonArtifact({ type: "text", value: ctx.params.value ?? "", createdAt: now });
      case "input.cameraPath":
        return jsonArtifact({ type: "camera_path", value: ctx.params.json ?? "[]", createdAt: now });
      case "model.groundingdino":
        return jsonArtifact({ boxes: [{ x: 0.25, y: 0.2, w: 0.5, h: 0.45, label: "object" }], createdAt: now });
      case "model.sam2": {
        return {
          kind: "mask",
          mimeType: "image/png",
          extension: "png",
          buffer: ONE_PIXEL_PNG,
          preview: {
            extension: "png",
            mimeType: "image/png",
            buffer: ONE_PIXEL_PNG
          },
          hash: hashBuffer(ONE_PIXEL_PNG),
          meta: { maskType: "binary", createdAt: now }
        };
      }
      case "model.sam3d_objects":
        return jsonArtifact({ objects: [{ id: "obj_1", confidence: 0.82 }], createdAt: now });
      case "model.qwen_vl":
        return jsonArtifact({ summary: "Mock VLM analysis output", createdAt: now });
      case "model.qwen_image_edit": {
        const hash = hashBuffer(ONE_PIXEL_PNG);
        return {
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          buffer: ONE_PIXEL_PNG,
          preview: {
            extension: "png",
            mimeType: "image/png",
            buffer: ONE_PIXEL_PNG
          },
          hash,
          meta: { prompt: ctx.params.prompt ?? "", createdAt: now }
        };
      }
      case "geo.depth_estimation": {
        const hash = hashBuffer(ONE_PIXEL_PNG);
        return {
          kind: "image",
          mimeType: "image/png",
          extension: "png",
          buffer: ONE_PIXEL_PNG,
          preview: {
            extension: "png",
            mimeType: "image/png",
            buffer: ONE_PIXEL_PNG
          },
          hash,
          meta: { semantic: "depth", createdAt: now }
        };
      }
      case "geo.pointcloud_from_depth": {
        const buffer = createPointCloudPlyBuffer();
        return {
          kind: "point_ply",
          mimeType: "application/octet-stream",
          extension: "ply",
          buffer,
          hash: hashBuffer(buffer),
          meta: { points: 8, createdAt: now }
        };
      }
      case "geo.mesh_reconstruction": {
        const buffer = createMinimalGlbBuffer();
        return {
          kind: "mesh_glb",
          mimeType: "model/gltf-binary",
          extension: "glb",
          buffer,
          hash: hashBuffer(buffer),
          meta: { triangles: 0, createdAt: now }
        };
      }
      case "geo.uv_unwrap": {
        const buffer = createMinimalGlbBuffer();
        return {
          kind: "mesh_glb",
          mimeType: "model/gltf-binary",
          extension: "glb",
          buffer,
          hash: hashBuffer(buffer),
          meta: { uvUnwrapped: true, createdAt: now }
        };
      }
      case "geo.bake_textures":
        return jsonArtifact({ textures: ["albedo", "normal"], createdAt: now });
      case "out.export_scene": {
        const format = (ctx.params.format as string | undefined) ?? "mesh_glb";
        if (format === "point_ply") {
          const buffer = createPointCloudPlyBuffer();
          return {
            kind: "point_ply",
            mimeType: "application/octet-stream",
            extension: "ply",
            buffer,
            hash: hashBuffer(buffer),
            meta: { points: 8, exporter: "mock", createdAt: now }
          };
        }
        if (format === "splat_ksplat") {
          const buffer = Buffer.from("ksplat placeholder\n", "utf8");
          return {
            kind: "splat_ksplat",
            mimeType: "application/octet-stream",
            extension: "ksplat",
            buffer,
            hash: hashBuffer(buffer),
            meta: { stub: true, exporter: "mock", createdAt: now }
          };
        }

        const buffer = createMinimalGlbBuffer();
        return {
          kind: "mesh_glb",
          mimeType: "model/gltf-binary",
          extension: "glb",
          buffer,
          hash: hashBuffer(buffer),
          meta: { exporter: "mock", compression: "none", createdAt: now }
        };
      }
      case "out.open_in_viewer":
        return jsonArtifact({ route: `/app/p/${ctx.projectId}/viewer`, createdAt: now });
      default:
        return jsonArtifact({ warning: `No mock for ${ctx.nodeType}`, createdAt: now });
    }
  }
}
