import { NextRequest } from "next/server";

export function getRequestIp(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

export function getRequestUserAgent(req: NextRequest) {
  return req.headers.get("user-agent") ?? "unknown";
}

