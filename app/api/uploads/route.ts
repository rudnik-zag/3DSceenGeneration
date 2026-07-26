import { NextRequest, NextResponse } from "next/server";
import { assertUploadEntitlement } from "@/lib/billing/entitlements";
import { requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { readJsonRequest } from "@/lib/security/request";
import { buildProjectUploadsPrefix, resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { uploadInitPayloadSchema } from "@/lib/validation/schemas";

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

const UPLOAD_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["video/mp4", "mp4"]
]);

const MAX_UPLOAD_BYTE_SIZE = 1024 * 1024 * 100;

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonRequest(req, 64 * 1024);
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
    const extension = UPLOAD_EXTENSIONS.get(contentType);
    const category =
      typeof data.category === "string" && data.category.trim().length > 0
        ? data.category.trim()
        : contentType.startsWith("video/")
          ? "input.video"
          : "input.image";
    const mediaFolder = contentType.startsWith("video/") ? "videos" : "images";
    if (!extension) {
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

    const safeStem = sanitizeFilename(filename.replace(/\.[^.]+$/, "")).replace(/^\.+/, "").slice(0, 220) || "upload";
    const safeFilename = `${safeStem}.${extension}`;
    const projectSlug = resolveProjectStorageSlug({
      projectSlug: access.project.slug,
      projectName: access.project.name,
      projectId: access.project.id
    });
    const key = `${buildProjectUploadsPrefix({ projectSlug })}/${access.project.id}/${mediaFolder}/${Date.now()}_${safeFilename}`;
    const uploadUrl = null;
    const directUploadUrl = `/api/storage/object?key=${encodeURIComponent(key)}`;

    const uploadAsset = await prisma.uploadAsset.create({
      data: {
        projectId: access.project.id,
        nodeId: data.nodeId ?? null,
        category,
        fileName: filename,
        mimeType: contentType,
        byteSize,
        storageKey: key
      },
      select: { id: true }
    });
    const uploadAssetId = uploadAsset.id;

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
