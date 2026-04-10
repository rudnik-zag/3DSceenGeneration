import { z } from "zod";

export const roleSchema = z.enum(["owner", "editor", "viewer"]);

export const registerPayloadSchema = z.object({
  email: z.string().email().min(3).max(320),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120).optional()
});

export const loginPayloadSchema = z.object({
  email: z.string().email().min(3).max(320),
  password: z.string().min(8).max(128)
});

export const createProjectPayloadSchema = z.object({
  name: z.string().min(1).max(120)
});

export const graphSavePayloadSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  graphJson: z.object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    viewport: z.unknown().optional()
  })
});

export const runCreatePayloadSchema = z.object({
  graphId: z.string().cuid().optional(),
  startNodeId: z.string().min(1).max(180).optional()
});

export const nodeRunPayloadSchema = z.object({
  graphId: z.string().cuid().optional(),
  forceNodeCacheBypass: z.boolean().optional()
});

export const uploadInitPayloadSchema = z.object({
  projectId: z.string().cuid(),
  nodeId: z.string().min(1).max(180).nullable().optional(),
  filename: z.string().min(1).max(260),
  contentType: z.string().min(1).max(140),
  byteSize: z.number().int().min(1).max(1024 * 1024 * 100)
});

export const artifactAccessQuerySchema = z.object({
  artifactId: z.string().cuid()
});

export const worldManifestQuerySchema = z.object({
  artifactId: z.string().cuid(),
  bundleMode: z.enum(["same_node", "project_fallback"]).optional()
});

export const worldTransformsGetQuerySchema = z.object({
  artifactId: z.string().cuid()
});

export const worldTransformsPostBodySchema = z.object({
  artifactId: z.string().cuid(),
  meshes: z.record(z.unknown()).optional(),
  splats: z.record(z.unknown()).optional(),
  sceneAlignment: z.unknown().optional()
});

export const runActionSchema = z.object({
  action: z.literal("cancel")
});

export const storageObjectPutQuerySchema = z.object({
  key: z.string().min(1).max(1024)
});

export const storageObjectGetQuerySchema = z.object({
  key: z.string().min(1).max(1024)
});

export const buildTilesetPayloadSchema = z.object({
  artifactId: z.string().cuid(),
  presetName: z.string().min(1).max(64).optional()
});

export const billingEstimatePayloadSchema = z.object({
  projectId: z.string().cuid(),
  graphId: z.string().cuid(),
  startNodeId: z.string().min(1).max(180).optional()
});

export const createSubscriptionCheckoutSchema = z.object({
  plan: z.enum(["Free", "Creator", "Pro", "Studio"])
});

export const createTokenPackCheckoutSchema = z.object({
  packKey: z.string().min(1).max(120)
});
