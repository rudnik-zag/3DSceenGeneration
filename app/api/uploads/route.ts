import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

import { prisma } from "@/lib/db";
import { safeGetSignedUploadUrl } from "@/lib/storage/s3";

let uploadAssetTableExists: boolean | null = null;
let loggedMissingUploadAssetTable = false;

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function slugifyProjectName(name: string) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

async function canPersistUploadAsset() {
  if (uploadAssetTableExists !== null) {
    return uploadAssetTableExists;
  }

  try {
    const result = await prisma.$queryRaw<Array<{ table_name: string | null }>>(
      Prisma.sql`SELECT to_regclass('public."UploadAsset"')::text AS table_name`
    );
    uploadAssetTableExists = Boolean(result[0]?.table_name);
  } catch {
    uploadAssetTableExists = false;
  }

  if (!uploadAssetTableExists && !loggedMissingUploadAssetTable) {
    loggedMissingUploadAssetTable = true;
    console.warn('[uploads] "UploadAsset" table missing; upload metadata persistence disabled until migrations are applied.');
  }

  return uploadAssetTableExists;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId : "shared";
  const filename = typeof body.filename === "string" ? body.filename : "upload.bin";
  const contentType = typeof body.contentType === "string" ? body.contentType : "application/octet-stream";
  const nodeId = typeof body.nodeId === "string" ? body.nodeId : null;
  const byteSize = typeof body.byteSize === "number" ? Math.max(0, Math.round(body.byteSize)) : 0;
  const safeFilename = sanitizeFilename(filename);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true }
  });
  const projectSlug = project ? slugifyProjectName(project.name) : "shared";
  const key = `projects/${projectId}/${projectSlug}/images/${Date.now()}_${safeFilename}`;
  const uploadUrl = await safeGetSignedUploadUrl(key, contentType);
  const directUploadUrl = uploadUrl ? null : `/api/storage/object?key=${encodeURIComponent(key)}`;

  let uploadAssetId: string | null = null;
  if (project && (await canPersistUploadAsset())) {
    uploadAssetId = randomUUID();
    try {
      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO "UploadAsset" ("id","projectId","nodeId","category","fileName","mimeType","byteSize","storageKey","createdAt")
        VALUES (${uploadAssetId}, ${project.id}, ${nodeId}, ${"input.image"}, ${filename}, ${contentType}, ${byteSize}, ${key}, NOW())`
      );
    } catch {
      uploadAssetId = null;
      uploadAssetTableExists = false;
    }
  }

  return NextResponse.json({
    key,
    uploadUrl,
    directUploadUrl,
    uploadAssetId
  });
}
