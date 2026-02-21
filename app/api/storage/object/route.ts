import { NextRequest, NextResponse } from "next/server";

import { getObjectBuffer, getStorageObjectContentType, putObjectToStorage } from "@/lib/storage/s3";

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
  const key = req.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const contentType = req.headers.get("content-type") ?? guessContentTypeFromKey(key);
  const body = Buffer.from(await req.arrayBuffer());
  await putObjectToStorage({
    key,
    body,
    contentType
  });

  return NextResponse.json({ ok: true, key });
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  try {
    const buffer = await getObjectBuffer(key);
    const contentType = (await getStorageObjectContentType(key)) ?? guessContentTypeFromKey(key);
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=300"
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
}
