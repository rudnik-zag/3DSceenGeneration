import IORedis from "ioredis";

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
