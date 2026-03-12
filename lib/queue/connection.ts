import IORedis from "ioredis";
import type { ConnectionOptions } from "bullmq";

import { env } from "@/lib/env";

declare global {
  // eslint-disable-next-line no-var
  var workflowRedisConnection: IORedis | undefined;
}

export const redisConnection =
  global.workflowRedisConnection ??
  new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

if (process.env.NODE_ENV !== "production") {
  global.workflowRedisConnection = redisConnection;
}

// BullMQ's bundled ioredis type can drift from our direct ioredis version.
// Runtime compatibility is maintained, but we cast here to keep TS stable.
export const redisConnectionForBullMq = redisConnection as unknown as ConnectionOptions;
