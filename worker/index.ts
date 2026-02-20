import { Worker } from "bullmq";

import { executeWorkflowRun } from "@/lib/execution/run-workflow";
import { redisConnection } from "@/lib/queue/connection";
import { RUN_WORKFLOW_QUEUE } from "@/lib/queue/queues";

async function main() {
  const worker = new Worker(
    RUN_WORKFLOW_QUEUE,
    async (job) => {
      await executeWorkflowRun(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );

  worker.on("ready", () => {
    console.log(`[worker] ready for queue ${RUN_WORKFLOW_QUEUE}`);
  });

  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id ?? "unknown"} failed`, err);
  });

  process.on("SIGINT", async () => {
    await worker.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
