import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { HttpError } from "@/lib/security/errors";

export function getRequestIp(req: NextRequest) {
  if (!env.TRUST_PROXY_HEADERS) return "unknown";
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export function getRequestUserAgent(req: NextRequest) {
  return req.headers.get("user-agent") ?? "unknown";
}

export async function readRequestText(req: NextRequest, maxBytes: number) {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "Request body is too large", "payload_too_large");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large", "payload_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function readJsonRequest(req: NextRequest, maxBytes = 1024 * 1024) {
  const raw = await readRequestText(req, maxBytes);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON request body", "invalid_json");
  }
}
