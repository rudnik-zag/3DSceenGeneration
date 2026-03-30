import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "bullmq";

import { executeWorkflowRun } from "@/lib/execution/run-workflow";
import { redisConnectionForBullMq } from "@/lib/queue/connection";
import { BUILD_SPLAT_TILESET_QUEUE, RUN_WORKFLOW_QUEUE } from "@/lib/queue/queues";
import { executeBuildSplatTilesetJob } from "@/lib/splats/build-tileset-job";

function loadWorkerEnv() {
  const cwd = process.cwd();
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const files = [
    `.env.${nodeEnv}.local`,
    ...(nodeEnv === "test" ? [] : [".env.local"]),
    `.env.${nodeEnv}`,
    ".env"
  ];

  for (const file of files) {
    const absolutePath = path.join(cwd, file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    process.loadEnvFile(absolutePath);
  }
}

loadWorkerEnv();

async function main() {
  const workflowWorker = new Worker(
    RUN_WORKFLOW_QUEUE,
    async (job) => {
      await executeWorkflowRun(job.data);
    },
    {
      connection: redisConnectionForBullMq,
      concurrency: 1
    }
  );

  workflowWorker.on("ready", () => {
    console.log(
      `[worker] ready for queue ${RUN_WORKFLOW_QUEUE} (SAM2_EXECUTION_MODE=${process.env.SAM2_EXECUTION_MODE ?? "mock"}, SAM2_CONDA_ENV=${process.env.SAM2_CONDA_ENV ?? "sam2"})`
    );
  });

  workflowWorker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });

  workflowWorker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id ?? "unknown"} failed`, err);
  });

  const splatTilesetWorker = new Worker(
    BUILD_SPLAT_TILESET_QUEUE,
    async (job) => {
      await executeBuildSplatTilesetJob(job.data);
    },
    {
      connection: redisConnectionForBullMq,
      concurrency: 1
    }
  );

  splatTilesetWorker.on("ready", () => {
    console.log(`[worker] ready for queue ${BUILD_SPLAT_TILESET_QUEUE}`);
  });

  splatTilesetWorker.on("completed", (job) => {
    console.log(`[worker] tileset job ${job.id} completed`);
  });

  splatTilesetWorker.on("failed", (job, err) => {
    console.error(`[worker] tileset job ${job?.id ?? "unknown"} failed`, err);
  });

  process.on("SIGINT", async () => {
    await Promise.allSettled([workflowWorker.close(), splatTilesetWorker.close()]);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
