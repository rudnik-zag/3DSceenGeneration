import { ArtifactKind, Prisma, RunStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { MockModelRunner } from "@/lib/execution/mock-runner";
import { makeCacheKey } from "@/lib/graph/cache";
import { buildExecutionPlan, parseGraphDocument } from "@/lib/graph/plan";
import { artifactPreviewStorageKey, artifactStorageKey } from "@/lib/storage/keys";
import { putObjectToStorage } from "@/lib/storage/s3";

export interface RunWorkflowInput {
  projectId: string;
  graphId: string;
  runId: string;
  startNodeId?: string;
}

const runner = new MockModelRunner();

function appendLog(prev: string, line: string) {
  return prev ? `${prev}\n${line}` : line;
}

async function updateRun(runId: string, data: Prisma.RunUpdateInput) {
  return prisma.run.update({ where: { id: runId }, data });
}

export async function executeWorkflowRun(input: RunWorkflowInput) {
  const run = await prisma.run.findUnique({ where: { id: input.runId } });
  if (!run) {
    throw new Error(`Run ${input.runId} not found`);
  }

  await updateRun(input.runId, {
    status: "running",
    startedAt: new Date(),
    logs: appendLog(run.logs, `[${new Date().toISOString()}] Run started`),
    progress: 0
  });

  try {
    const graph = await prisma.graph.findUnique({ where: { id: input.graphId } });
    if (!graph) {
      throw new Error(`Graph ${input.graphId} not found`);
    }

    const document = parseGraphDocument(graph.graphJson);
    const plan = buildExecutionPlan(document, input.startNodeId);

    const artifactByNodeId = new Map<
      string,
      {
        id: string;
        hash: string;
        kind: ArtifactKind;
      }
    >();

    const total = plan.tasks.length;

    for (let i = 0; i < total; i += 1) {
      const task = plan.tasks[i];

      const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
      if (latestRun?.status === "canceled") {
        throw new Error("Run canceled by user");
      }

      const dependencyArtifacts = [] as Array<{ id: string; hash: string; kind: ArtifactKind }>;
      for (const dep of task.dependsOn) {
        const known = artifactByNodeId.get(dep);
        if (known) {
          dependencyArtifacts.push(known);
          continue;
        }

        const latestArtifact = await prisma.artifact.findFirst({
          where: {
            projectId: input.projectId,
            nodeId: dep
          },
          orderBy: { createdAt: "desc" }
        });

        if (latestArtifact) {
          dependencyArtifacts.push({
            id: latestArtifact.id,
            hash: latestArtifact.hash,
            kind: latestArtifact.kind
          });
        }
      }

      const cacheKey = makeCacheKey(
        task.nodeType,
        task.params,
        dependencyArtifacts.map((a) => a.hash)
      );

      const cacheHit = await prisma.cacheEntry.findUnique({
        where: { cacheKey },
        include: { artifact: true }
      });

      const now = new Date().toISOString();

      if (cacheHit?.artifact) {
        artifactByNodeId.set(task.nodeId, {
          id: cacheHit.artifact.id,
          hash: cacheHit.artifact.hash,
          kind: cacheHit.artifact.kind
        });

        const progress = Math.round(((i + 1) / total) * 100);
        const current = await prisma.run.findUnique({ where: { id: input.runId } });
        await updateRun(input.runId, {
          progress,
          logs: appendLog(current?.logs ?? "", `[${now}] ${task.nodeId} cache-hit (${cacheHit.artifact.id})`)
        });
        continue;
      }

      const output = await runner.runNode({
        projectId: input.projectId,
        runId: input.runId,
        nodeId: task.nodeId,
        nodeType: task.nodeType,
        params: task.params,
        dependencyArtifacts
      });

      const created = await prisma.artifact.create({
        data: {
          runId: input.runId,
          projectId: input.projectId,
          nodeId: task.nodeId,
          kind: output.kind,
          mimeType: output.mimeType,
          byteSize: output.buffer.length,
          hash: output.hash,
          storageKey: "pending",
          previewStorageKey: null,
          meta: output.meta ?? {}
        }
      });

      const key = artifactStorageKey({
        projectId: input.projectId,
        runId: input.runId,
        nodeId: task.nodeId,
        artifactId: created.id,
        extension: output.extension
      });

      await putObjectToStorage({
        key,
        body: output.buffer,
        contentType: output.mimeType
      });

      let previewKey: string | null = null;
      if (output.preview) {
        previewKey = artifactPreviewStorageKey({
          projectId: input.projectId,
          runId: input.runId,
          nodeId: task.nodeId,
          artifactId: created.id,
          extension: output.preview.extension
        });

        await putObjectToStorage({
          key: previewKey,
          body: output.preview.buffer,
          contentType: output.preview.mimeType
        });
      }

      const artifact = await prisma.artifact.update({
        where: { id: created.id },
        data: {
          storageKey: key,
          previewStorageKey: previewKey,
          byteSize: output.buffer.length,
          hash: output.hash
        }
      });

      artifactByNodeId.set(task.nodeId, {
        id: artifact.id,
        hash: artifact.hash,
        kind: artifact.kind
      });

      await prisma.cacheEntry.upsert({
        where: { cacheKey },
        create: {
          projectId: input.projectId,
          cacheKey,
          artifactId: artifact.id
        },
        update: {
          artifactId: artifact.id
        }
      });

      const progress = Math.round(((i + 1) / total) * 100);
      const current = await prisma.run.findUnique({ where: { id: input.runId } });
      await updateRun(input.runId, {
        progress,
        logs: appendLog(current?.logs ?? "", `[${now}] ${task.nodeId} executed (${artifact.id})`)
      });
    }

    const current = await prisma.run.findUnique({ where: { id: input.runId } });
    await updateRun(input.runId, {
      status: "success",
      progress: 100,
      finishedAt: new Date(),
      logs: appendLog(current?.logs ?? "", `[${new Date().toISOString()}] Run finished`) 
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution error";
    const current = await prisma.run.findUnique({ where: { id: input.runId } });

    const status: RunStatus = message.toLowerCase().includes("canceled") ? "canceled" : "error";

    await updateRun(input.runId, {
      status,
      finishedAt: new Date(),
      logs: appendLog(current?.logs ?? "", `[${new Date().toISOString()}] ERROR: ${message}`)
    });

    throw error;
  }
}
