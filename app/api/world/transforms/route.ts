import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

import { requireArtifactAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { worldTransformsGetQuerySchema, worldTransformsPostBodySchema } from "@/lib/validation/schemas";

interface TransformRecord {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface ViewerTransformsPayload {
  version: 1;
  artifactId: string;
  updatedAt: string;
  meshes: Record<string, TransformRecord>;
  splats: Record<string, TransformRecord>;
  sceneAlignment?: TransformRecord | null;
}

function getLocalStorageRoot() {
  const configured = process.env.LOCAL_STORAGE_ROOT?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : path.join(process.cwd(), ".local-storage");
}

function buildTransformsFilePath(input: {
  projectSlug: string;
  runId: string;
  nodeId: string;
}) {
  return path.join(
    getLocalStorageRoot(),
    "projects",
    input.projectSlug,
    "runs",
    input.runId,
    "nodes",
    input.nodeId,
    "viewer_transforms.json"
  );
}

function isNumberTuple(value: unknown, length: number) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isValidTransformRecord(value: unknown): value is TransformRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    isNumberTuple(obj.position, 3) &&
    isNumberTuple(obj.rotation, 4) &&
    isNumberTuple(obj.scale, 3)
  );
}

function sanitizeTransformsMap(raw: unknown): Record<string, TransformRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>);
  const cleaned: Record<string, TransformRecord> = {};
  for (const [key, value] of entries) {
    if (!key || !isValidTransformRecord(value)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function sanitizeTransformRecord(raw: unknown): TransformRecord | null {
  return isValidTransformRecord(raw) ? raw : null;
}

async function resolveContext(artifactId: string) {
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    include: {
      project: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });
  if (!artifact) {
    return { error: NextResponse.json({ error: "Artifact not found" }, { status: 404 }) };
  }
  if (!artifact.runId || !artifact.nodeId) {
    return { error: NextResponse.json({ error: "Artifact is missing run/node context" }, { status: 400 }) };
  }

  const projectSlug = resolveProjectStorageSlug({
    projectName: artifact.project.name,
    projectId: artifact.project.id
  });

  return {
    artifact,
    projectSlug,
    transformsPath: buildTransformsFilePath({
      projectSlug,
      runId: artifact.runId,
      nodeId: artifact.nodeId
    })
  };
}

export async function GET(req: NextRequest) {
  try {
    const parsedQuery = worldTransformsGetQuerySchema.safeParse({
      artifactId: req.nextUrl.searchParams.get("artifactId")
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "validation_error", message: "artifactId is required", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const artifactId = parsedQuery.data.artifactId;
    const access = await requireArtifactAccess(artifactId, "viewer");
    const context = await resolveContext(artifactId);
    if ("error" in context) return context.error;

    try {
      const raw = await fs.readFile(context.transformsPath, "utf8");
      const parsed = JSON.parse(raw) as ViewerTransformsPayload;
      await logAuditEventFromRequest(req, {
        action: "viewer_transforms_read",
        resourceType: "artifact",
        resourceId: artifactId,
        projectId: access.project.id,
        userId: access.user.id
      });
      return NextResponse.json({
        ok: true,
        artifactId,
        payload: {
          version: 1,
          artifactId,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          meshes: sanitizeTransformsMap(parsed.meshes),
          splats: sanitizeTransformsMap(parsed.splats),
          sceneAlignment: sanitizeTransformRecord(parsed.sceneAlignment)
        }
      });
    } catch {
      await logAuditEventFromRequest(req, {
        action: "viewer_transforms_read",
        resourceType: "artifact",
        resourceId: artifactId,
        projectId: access.project.id,
        userId: access.user.id
      });
      return NextResponse.json({
        ok: true,
        artifactId,
        payload: {
          version: 1,
          artifactId,
          updatedAt: new Date().toISOString(),
          meshes: {},
          splats: {},
          sceneAlignment: null
        }
      });
    }
  } catch (error) {
    return toApiErrorResponse(error, "Failed to load viewer transforms");
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsedBody = worldTransformsPostBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid transforms payload", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const artifactId = parsedBody.data.artifactId;
    const access = await requireArtifactAccess(artifactId, "editor");
    const context = await resolveContext(artifactId);
    if ("error" in context) return context.error;

    const meshes = sanitizeTransformsMap(parsedBody.data.meshes);
    const splats = sanitizeTransformsMap(parsedBody.data.splats);
    const sceneAlignment = sanitizeTransformRecord(parsedBody.data.sceneAlignment);
    const payload: ViewerTransformsPayload = {
      version: 1,
      artifactId,
      updatedAt: new Date().toISOString(),
      meshes,
      splats,
      sceneAlignment
    };

    await fs.mkdir(path.dirname(context.transformsPath), { recursive: true });
    await fs.writeFile(context.transformsPath, JSON.stringify(payload, null, 2), "utf8");

    await logAuditEventFromRequest(req, {
      action: "viewer_transforms_update",
      resourceType: "artifact",
      resourceId: artifactId,
      projectId: access.project.id,
      userId: access.user.id
    });

    return NextResponse.json({
      ok: true,
      artifactId,
      savedMeshCount: Object.keys(meshes).length,
      savedSplatCount: Object.keys(splats).length,
      savedSceneAlignment: Boolean(sceneAlignment)
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to save viewer transforms");
  }
}
