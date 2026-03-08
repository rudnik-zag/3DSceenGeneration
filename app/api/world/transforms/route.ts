import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

import { prisma } from "@/lib/db";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";

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
  const artifactId = req.nextUrl.searchParams.get("artifactId")?.trim() ?? "";
  if (!artifactId) {
    return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
  }

  const context = await resolveContext(artifactId);
  if ("error" in context) return context.error;

  try {
    const raw = await fs.readFile(context.transformsPath, "utf8");
    const parsed = JSON.parse(raw) as ViewerTransformsPayload;
    return NextResponse.json({
      ok: true,
      artifactId,
      transformsPath: context.transformsPath,
      payload: {
        version: 1,
        artifactId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        meshes: sanitizeTransformsMap(parsed.meshes),
        splats: sanitizeTransformsMap(parsed.splats)
      }
    });
  } catch {
    return NextResponse.json({
      ok: true,
      artifactId,
      transformsPath: context.transformsPath,
      payload: {
        version: 1,
        artifactId,
        updatedAt: new Date().toISOString(),
        meshes: {},
        splats: {}
      }
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const artifactId = typeof body.artifactId === "string" ? body.artifactId.trim() : "";
  if (!artifactId) {
    return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
  }

  const context = await resolveContext(artifactId);
  if ("error" in context) return context.error;

  const meshes = sanitizeTransformsMap(body.meshes);
  const splats = sanitizeTransformsMap(body.splats);
  const payload: ViewerTransformsPayload = {
    version: 1,
    artifactId,
    updatedAt: new Date().toISOString(),
    meshes,
    splats
  };

  await fs.mkdir(path.dirname(context.transformsPath), { recursive: true });
  await fs.writeFile(context.transformsPath, JSON.stringify(payload, null, 2), "utf8");

  return NextResponse.json({
    ok: true,
    artifactId,
    transformsPath: context.transformsPath,
    savedMeshCount: Object.keys(meshes).length,
    savedSplatCount: Object.keys(splats).length
  });
}
