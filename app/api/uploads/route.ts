import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

import { assertUploadEntitlement } from "@/lib/billing/entitlements";
import { requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { buildProjectUploadsPrefix, resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { safeGetSignedUploadUrl } from "@/lib/storage/s3";
import { uploadInitPayloadSchema } from "@/lib/validation/schemas";

let uploadAssetTableExists: boolean | null = null;
let loggedMissingUploadAssetTable = false;

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "application/json",
  "model/gltf-binary",
  "application/octet-stream"
]);

const MAX_UPLOAD_BYTE_SIZE = 1024 * 1024 * 100;

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
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = uploadInitPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid upload payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const data = parsed.data;
    const access = await requireProjectAccess(data.projectId, "editor");
    await enforceRateLimit({
      bucket: "upload:init",
      identifier: access.user.id,
      limit: env.UPLOAD_INIT_LIMIT,
      windowSec: env.UPLOAD_INIT_WINDOW_SEC,
      message: "Upload initialization rate limit exceeded"
    });

    const filename = data.filename.trim();
    const contentType = data.contentType.trim().toLowerCase();
    const byteSize = Math.max(1, Math.round(data.byteSize));
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(contentType)) {
      return NextResponse.json({ error: "unsupported_file_type", message: "Unsupported content type." }, { status: 400 });
    }
    if (byteSize > MAX_UPLOAD_BYTE_SIZE) {
      return NextResponse.json({ error: "file_too_large", message: "File exceeds max allowed size." }, { status: 400 });
    }
    if (env.BILLING_ENFORCEMENT_ENABLED) {
      await assertUploadEntitlement({
        userId: access.user.id,
        byteSize
      });
    }

    const safeFilename = sanitizeFilename(filename);
    const projectSlug = resolveProjectStorageSlug({
      projectSlug: access.project.slug,
      projectName: access.project.name,
      projectId: access.project.id
    });
    const key = `${buildProjectUploadsPrefix({ projectSlug })}/${access.project.id}/images/${Date.now()}_${safeFilename}`;
    const uploadUrl = await safeGetSignedUploadUrl(key, contentType, env.SIGNED_URL_TTL_SEC);
    const directUploadUrl = uploadUrl ? null : `/api/storage/object?key=${encodeURIComponent(key)}`;

    let uploadAssetId: string | null = null;
    if (await canPersistUploadAsset()) {
      uploadAssetId = randomUUID();
      try {
        await prisma.$executeRaw(
          Prisma.sql`INSERT INTO "UploadAsset" ("id","projectId","nodeId","category","fileName","mimeType","byteSize","storageKey","createdAt")
          VALUES (${uploadAssetId}, ${access.project.id}, ${data.nodeId ?? null}, ${"input.image"}, ${filename}, ${contentType}, ${byteSize}, ${key}, NOW())`
        );
      } catch {
        uploadAssetId = null;
        uploadAssetTableExists = false;
      }
    }

    await logAuditEventFromRequest(req, {
      action: "upload_init",
      resourceType: "upload",
      resourceId: uploadAssetId,
      projectId: access.project.id,
      userId: access.user.id
    });

    return NextResponse.json({
      key,
      uploadUrl,
      directUploadUrl,
      uploadAssetId
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to initialize upload");
  }
}
