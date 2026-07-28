import { NextRequest, NextResponse } from "next/server";

import { requireStorageObjectAccess, requireUploadStorageObjectAccess } from "@/lib/auth/access";
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
  if (lowered.endsWith(".mp4")) return "video/mp4";
  if (lowered.endsWith(".json")) return "application/json";
  if (lowered.endsWith(".glb")) return "model/gltf-binary";
  if (lowered.endsWith(".ply")) return "application/octet-stream";
  return "application/octet-stream";
}

function deriveLegacyDepthVideoKey(key: string) {
  const match = key.match(/^(.*)\/outputs\/depth-?video\.mp4$/i);
  return match?.[1] ? `${match[1]}/depth_anything3/depth_preview.mp4` : null;
}

async function getObjectBufferWithLegacyFallback(key: string) {
  try {
    return {
      buffer: await getObjectBuffer(key),
      resolvedKey: key
    };
  } catch (error) {
    const legacyKey = deriveLegacyDepthVideoKey(key);
    if (!legacyKey) throw error;
    return {
      buffer: await getObjectBuffer(legacyKey),
      resolvedKey: legacyKey
    };
  }
}

function isInlineContentType(contentType: string) {
  return (
    contentType === "image/png" ||
    contentType === "image/jpeg" ||
    contentType === "image/webp" ||
    contentType === "video/mp4"
  );
}

function buildReadHeaders(contentType: string, byteLength: number, extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(byteLength),
    "Cache-Control": "private, max-age=600, immutable",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": isInlineContentType(contentType) ? "inline" : "attachment",
    ...(extra ?? {})
  };

  if (!isInlineContentType(contentType)) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
  }

  return headers;
}

function parseRangeHeader(rangeHeader: string | null, totalBytes: number) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid" as const;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return "invalid" as const;

  let start: number;
  let end: number;

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid" as const;
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : totalBytes - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalBytes
  ) {
    return "invalid" as const;
  }

  return {
    start,
    end: Math.min(end, totalBytes - 1)
  };
}

async function readUploadBody(req: NextRequest, expectedBytes: number) {
  const contentLength = Number(req.headers.get("content-length"));
  if (!Number.isInteger(contentLength) || contentLength !== expectedBytes) {
    throw new HttpError(400, "Upload size does not match initialization", "upload_size_mismatch");
  }
  if (!req.body) {
    throw new HttpError(400, "Upload body is required", "validation_error");
  }
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expectedBytes) {
      await reader.cancel();
      throw new HttpError(413, "Upload exceeds initialized size", "file_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  if (total !== expectedBytes) {
    throw new HttpError(400, "Upload size does not match initialization", "upload_size_mismatch");
  }
  return Buffer.concat(chunks, total);
}

function hasPrefix(body: Buffer, bytes: number[]) {
  return bytes.every((value, index) => body[index] === value);
}

function validateUploadContent(body: Buffer, contentType: string) {
  const valid = (() => {
    if (contentType === "image/png") return hasPrefix(body, [0x89, 0x50, 0x4e, 0x47]);
    if (contentType === "image/jpeg") return hasPrefix(body, [0xff, 0xd8, 0xff]);
    if (contentType === "image/webp") return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
    if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("ascii"));
    if (contentType === "image/bmp") return body.subarray(0, 2).toString("ascii") === "BM";
    if (contentType === "image/tiff") return ["II*\u0000", "MM\u0000*"].includes(body.subarray(0, 4).toString("binary"));
    if (contentType === "video/mp4") return body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp";
    if (contentType === "model/gltf-binary") return body.subarray(0, 4).toString("ascii") === "glTF";
    if (contentType === "application/json") {
      try {
        JSON.parse(body.toString("utf8"));
        return true;
      } catch {
        return false;
      }
    }
    return contentType === "application/octet-stream";
  })();
  if (!valid) {
    throw new HttpError(400, "Uploaded bytes do not match declared content type", "upload_content_mismatch");
  }
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
    const access = await requireUploadStorageObjectAccess(key, "editor");
    await enforceRateLimit({
      bucket: "storage:put",
      identifier: access.user.id,
      limit: env.UPLOAD_INIT_LIMIT,
      windowSec: env.UPLOAD_INIT_WINDOW_SEC,
      message: "Storage write rate limit exceeded"
    });

    const contentType = (req.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== access.uploadAsset.mimeType.toLowerCase()) {
      throw new HttpError(400, "Upload content type does not match initialization", "upload_type_mismatch");
    }
    const body = await readUploadBody(req, access.uploadAsset.byteSize);
    validateUploadContent(body, contentType);
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
      limit: env.STORAGE_OBJECT_READ_LIMIT,
      windowSec: env.STORAGE_OBJECT_READ_WINDOW_SEC,
      message: "Storage read rate limit exceeded"
    });

    try {
      const { buffer, resolvedKey } = await getObjectBufferWithLegacyFallback(key);
      const contentType =
        resolvedKey === key
          ? (await getStorageObjectContentType(key).catch(() => null)) ?? guessContentTypeFromKey(key)
          : guessContentTypeFromKey(key);
      const range = parseRangeHeader(req.headers.get("range"), buffer.length);
      await logAuditEventFromRequest(req, {
        action: "storage_object_read",
        resourceType: "storage_object",
        resourceId: key,
        projectId: access.project.id,
        userId: access.user.id
      });
      if (range === "invalid") {
        return new NextResponse(null, {
          status: 416,
          headers: buildReadHeaders(contentType, 0, {
            "Content-Range": `bytes */${buffer.length}`
          })
        });
      }
      if (range) {
        const chunk = buffer.subarray(range.start, range.end + 1);
        return new NextResponse(chunk, {
          status: 206,
          headers: buildReadHeaders(contentType, chunk.length, {
            "Content-Range": `bytes ${range.start}-${range.end}/${buffer.length}`
          })
        });
      }
      return new NextResponse(buffer, {
        status: 200,
        headers: buildReadHeaders(contentType, buffer.length)
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
