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
    const count = Number(await redisConnection.eval(
      "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
      1,
      key,
      safeWindow
    ));
    if (count > safeLimit) {
      throw new HttpError(429, input.message ?? "Too many requests", "rate_limited");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(503, "Rate limiting is temporarily unavailable", "rate_limit_unavailable");
    }
    console.warn("[rate-limit] Redis unavailable, skipping limit enforcement outside production.");
  }
}
