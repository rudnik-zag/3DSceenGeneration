import { Queue } from "bullmq";

import { redisConnection } from "@/lib/queue/connection";

export const RUN_WORKFLOW_QUEUE = "runWorkflow";

declare global {
  // eslint-disable-next-line no-var
  var runWorkflowQueue: Queue | undefined;
}

export const runWorkflowQueue =
  global.runWorkflowQueue ??
  new Queue(RUN_WORKFLOW_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100
    }
  });

if (process.env.NODE_ENV !== "production") {
  global.runWorkflowQueue = runWorkflowQueue;
}
