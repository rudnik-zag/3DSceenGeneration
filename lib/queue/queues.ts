import { Queue } from "bullmq";

import { redisConnectionForBullMq } from "@/lib/queue/connection";

export const RUN_WORKFLOW_QUEUE = "runWorkflow";
export const BUILD_SPLAT_TILESET_QUEUE = "buildSplatTilesetFromPly";

declare global {
  // eslint-disable-next-line no-var
  var runWorkflowQueue: Queue | undefined;
  // eslint-disable-next-line no-var
  var buildSplatTilesetQueue: Queue | undefined;
}

export const runWorkflowQueue =
  global.runWorkflowQueue ??
  new Queue(RUN_WORKFLOW_QUEUE, {
    connection: redisConnectionForBullMq,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });

if (process.env.NODE_ENV !== "production") {
  global.runWorkflowQueue = runWorkflowQueue;
}

export const buildSplatTilesetQueue =
  global.buildSplatTilesetQueue ??
  new Queue(BUILD_SPLAT_TILESET_QUEUE, {
    connection: redisConnectionForBullMq,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100
    }
  });

if (process.env.NODE_ENV !== "production") {
  global.buildSplatTilesetQueue = buildSplatTilesetQueue;
}
