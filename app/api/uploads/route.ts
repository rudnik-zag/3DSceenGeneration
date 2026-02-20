import { NextRequest, NextResponse } from "next/server";

import { getSignedUploadUrl } from "@/lib/storage/s3";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId : "shared";
  const filename = typeof body.filename === "string" ? body.filename : "upload.bin";
  const contentType = typeof body.contentType === "string" ? body.contentType : "application/octet-stream";

  const key = `projects/${projectId}/uploads/${Date.now()}_${filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  const uploadUrl = await getSignedUploadUrl(key, contentType);

  return NextResponse.json({ key, uploadUrl });
}
