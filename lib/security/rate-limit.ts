import { redisConnection } from "@/lib/queue/connection";
import { HttpError } from "@/lib/security/errors";

function normalizeIdentifier(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9:._-]/g, "_").slice(0, 180);
}

function windowBucket(windowSec: number) {
  return Math.floor(Date.now() / 1000 / windowSec);
}

export async function enforceRateLimit(input: {
  bucket: string;
  identifier: string;
  limit: number;
  windowSec: number;
  message?: string;
}) {
  const safeLimit = Math.max(1, Math.floor(input.limit));
  const safeWindow = Math.max(1, Math.floor(input.windowSec));
  const key = `rate:${normalizeIdentifier(input.bucket)}:${normalizeIdentifier(input.identifier)}:${windowBucket(safeWindow)}`;

  try {
    const count = await redisConnection.incr(key);
    if (count === 1) {
      await redisConnection.expire(key, safeWindow);
    }
    if (count > safeLimit) {
      throw new HttpError(429, input.message ?? "Too many requests", "rate_limited");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // Fail-open when Redis is unavailable to avoid hard downtime.
    console.warn("[rate-limit] Redis unavailable, skipping limit enforcement.");
  }
}

