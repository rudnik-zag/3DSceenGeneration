import { NextRequest, NextResponse } from "next/server";

import { requireStorageObjectAccess } from "@/lib/auth/access";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { HttpError, toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getObjectBuffer, getStorageObjectContentType, putObjectToStorage } from "@/lib/storage/s3";
import { storageObjectGetQuerySchema, storageObjectPutQuerySchema } from "@/lib/validation/schemas";

function guessContentTypeFromKey(key: string) {
  const lowered = key.toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "image/jpeg";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".json")) return "application/json";
  if (lowered.endsWith(".glb")) return "model/gltf-binary";
  if (lowered.endsWith(".ply")) return "application/octet-stream";
  return "application/octet-stream";
}

export async function PUT(req: NextRequest) {
  try {
    const parsed = storageObjectPutQuerySchema.safeParse({
      key: req.nextUrl.searchParams.get("key")
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "validation_error", message: "Missing or invalid key" }, { status: 400 });
    }
    const key = parsed.data.key;
    const access = await requireStorageObjectAccess(key, "editor");
    await enforceRateLimit({
      bucket: "storage:put",
      identifier: access.user.id,
      limit: env.UPLOAD_INIT_LIMIT,
      windowSec: env.UPLOAD_INIT_WINDOW_SEC,
      message: "Storage write rate limit exceeded"
    });

    const contentType = req.headers.get("content-type") ?? guessContentTypeFromKey(key);
    const body = Buffer.from(await req.arrayBuffer());
    await putObjectToStorage({
      key,
      body,
      contentType
    });

    await logAuditEventFromRequest(req, {
      action: "storage_object_write",
      resourceType: "storage_object",
      resourceId: key,
      projectId: access.project.id,
      userId: access.user.id
    });

    return NextResponse.json({ ok: true, key });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
      const key = req.nextUrl.searchParams.get("key") ?? null;
      await logAuditEventFromRequest(req, {
        action: "secure_file_access_attempt",
        resourceType: "storage_object",
        resourceId: key,
        projectId: null,
        userId: null
      });
    }
    return toApiErrorResponse(error, "Failed to write storage object");
  }
}

export async function GET(req: NextRequest) {
  try {
    const parsed = storageObjectGetQuerySchema.safeParse({
      key: req.nextUrl.searchParams.get("key")
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "validation_error", message: "Missing or invalid key" }, { status: 400 });
    }
    const key = parsed.data.key;
    const access = await requireStorageObjectAccess(key, "viewer");
    await enforceRateLimit({
      bucket: "storage:get",
      identifier: access.user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Storage read rate limit exceeded"
    });

    try {
      const buffer = await getObjectBuffer(key);
      const contentType = (await getStorageObjectContentType(key)) ?? guessContentTypeFromKey(key);
      await logAuditEventFromRequest(req, {
        action: "storage_object_read",
        resourceType: "storage_object",
        resourceId: key,
        projectId: access.project.id,
        userId: access.user.id
      });
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, no-store"
        }
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: "ObjectNotFound",
          key,
          message: error instanceof Error ? error.message : "Failed to load object"
        },
        { status: 404 }
      );
    }
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) {
      const key = req.nextUrl.searchParams.get("key") ?? null;
      await logAuditEventFromRequest(req, {
        action: "secure_file_access_attempt",
        resourceType: "storage_object",
        resourceId: key,
        projectId: null,
        userId: null
      });
    }
    return toApiErrorResponse(error, "Failed to read storage object");
  }
}
