import { ArtifactKind, Prisma, RunStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { ResolvedArtifactInput } from "@/lib/execution/contracts";
import { MockModelRunner, stableHashForOutput } from "@/lib/execution/mock-runner";
import { makeCacheKey, makeOutputCacheKey } from "@/lib/graph/cache";
import { nodeSpecRegistry } from "@/lib/graph/node-specs";
import { buildExecutionPlan, parseGraphDocument } from "@/lib/graph/plan";
import { artifactPreviewStorageKey, artifactStorageKey } from "@/lib/storage/keys";
import { getObjectBuffer, putObjectToStorage } from "@/lib/storage/s3";
import { WorkflowNodeType } from "@/types/workflow";

export interface RunWorkflowInput {
  projectId: string;
  graphId: string;
  runId: string;
  startNodeId?: string;
}

const runner = new MockModelRunner();

interface RuntimeArtifactRef extends ResolvedArtifactInput {
  createdAt: Date;
  previewStorageKey: string | null;
}

function appendLog(prev: string, line: string) {
  return prev ? `${prev}\n${line}` : line;
}

async function updateRun(runId: string, data: Prisma.RunUpdateInput) {
  return prisma.run.update({ where: { id: runId }, data });
}

function mapArtifact(artifact: {
  id: string;
  nodeId: string;
  kind: ArtifactKind;
  hash: string;
  mimeType: string;
  storageKey: string;
  byteSize: number;
  previewStorageKey: string | null;
  createdAt: Date;
  meta: Prisma.JsonValue | null;
}): RuntimeArtifactRef {
  const meta = artifact.meta && typeof artifact.meta === "object" && !Array.isArray(artifact.meta)
    ? (artifact.meta as Record<string, unknown>)
    : {};
  const outputId = typeof meta.outputKey === "string" ? meta.outputKey : "default";
  return {
    artifactId: artifact.id,
    nodeId: artifact.nodeId,
    outputId,
    kind: artifact.kind,
    hash: artifact.hash,
    mimeType: artifact.mimeType,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    meta,
    createdAt: artifact.createdAt,
    previewStorageKey: artifact.previewStorageKey
  };
}

function mapKey(nodeId: string, outputId: string) {
  return `${nodeId}:${outputId}`;
}

async function findArtifactById(projectId: string, artifactId: string): Promise<RuntimeArtifactRef | null> {
  const artifact = await prisma.artifact.findFirst({
    where: {
      id: artifactId,
      projectId
    }
  });
  return artifact ? mapArtifact(artifact) : null;
}

async function findLatestArtifactByNodeOutput(projectId: string, nodeId: string, outputId: string): Promise<RuntimeArtifactRef | null> {
  const candidates = await prisma.artifact.findMany({
    where: {
      projectId,
      nodeId
    },
    orderBy: { createdAt: "desc" },
    take: 24
  });
  const matched = candidates.find((item) => {
    if (!item.meta || typeof item.meta !== "object" || Array.isArray(item.meta)) return outputId === "default";
    const key = (item.meta as Record<string, unknown>).outputKey;
    return (typeof key === "string" ? key : "default") === outputId;
  });
  return matched ? mapArtifact(matched) : null;
}

function requiredInputPorts(nodeType: WorkflowNodeType) {
  const spec = nodeSpecRegistry[nodeType];
  return spec.inputPorts.filter((port) => port.required).map((port) => port.id);
}

function orderedInputHashes(nodeType: WorkflowNodeType, inputsByPort: Record<string, RuntimeArtifactRef[]>) {
  const spec = nodeSpecRegistry[nodeType];
  const ordered: string[] = [];
  for (const port of spec.inputPorts) {
    const entries = [...(inputsByPort[port.id] ?? [])].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    for (const entry of entries) {
      ordered.push(entry.hash);
    }
  }
  return ordered;
}

function parseBoxesMeta(artifact?: RuntimeArtifactRef | null) {
  if (!artifact) return { sourceImageArtifactId: null as string | null, sourceImageHash: null as string | null };
  const sourceImageArtifactId =
    typeof artifact.meta.sourceImageArtifactId === "string" ? artifact.meta.sourceImageArtifactId : null;
  const sourceImageHash = typeof artifact.meta.sourceImageHash === "string" ? artifact.meta.sourceImageHash : null;
  return { sourceImageArtifactId, sourceImageHash };
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
    const producedByOutput = new Map<string, RuntimeArtifactRef>();
    const producedByArtifactId = new Map<string, RuntimeArtifactRef>();
    const total = Math.max(1, plan.tasks.length);

    for (let i = 0; i < plan.tasks.length; i += 1) {
      const task = plan.tasks[i];
      const spec = nodeSpecRegistry[task.nodeType];
      const now = new Date().toISOString();
      const currentRun = await prisma.run.findUnique({ where: { id: input.runId } });
      if (currentRun?.status === "canceled") {
        throw new Error("Run canceled by user");
      }

      const inputsByPort: Record<string, RuntimeArtifactRef[]> = {};
      for (const binding of task.inputBindings) {
        const produced = producedByOutput.get(mapKey(binding.sourceNodeId, binding.sourceOutputId));
        const resolved =
          produced ?? (await findLatestArtifactByNodeOutput(input.projectId, binding.sourceNodeId, binding.sourceOutputId));
        if (!resolved) {
          continue;
        }
        if (!inputsByPort[binding.inputPortId]) {
          inputsByPort[binding.inputPortId] = [];
        }
        inputsByPort[binding.inputPortId].push(resolved);
        producedByArtifactId.set(resolved.artifactId, resolved);
      }

      let runtimeMode: string | undefined;
      const runtimeWarnings: string[] = [];
      if (task.nodeType === "model.sam2") {
        const directImage = inputsByPort.image?.[0];
        const boxesInput = inputsByPort.boxes?.[0];
        if (boxesInput) {
          runtimeMode = "guided";
          const { sourceImageArtifactId, sourceImageHash } = parseBoxesMeta(boxesInput);
          let sourcedImage: RuntimeArtifactRef | null = null;
          if (sourceImageArtifactId) {
            sourcedImage =
              producedByArtifactId.get(sourceImageArtifactId) ??
              (await findArtifactById(input.projectId, sourceImageArtifactId));
            if (sourcedImage) {
              producedByArtifactId.set(sourcedImage.artifactId, sourcedImage);
            }
          }

          if (directImage && sourceImageHash && directImage.hash !== sourceImageHash) {
            runtimeWarnings.push("Boxes input does not match image input. Using GroundingDINO source image.");
          }

          const effectiveImage = sourcedImage ?? directImage;
          if (!effectiveImage) {
            throw new Error(`Node ${task.nodeId} could not resolve image for SAM2 guided mode`);
          }
          inputsByPort.image = [effectiveImage];
          inputsByPort.boxes = [boxesInput];
        } else {
          runtimeMode = "full";
          if (!directImage) {
            throw new Error(`Node ${task.nodeId} requires image input`);
          }
          inputsByPort.image = [directImage];
        }
      }

      for (const requiredPort of requiredInputPorts(task.nodeType)) {
        if (!inputsByPort[requiredPort] || inputsByPort[requiredPort].length === 0) {
          throw new Error(`Node ${task.nodeId} missing required input "${requiredPort}"`);
        }
      }

      const nodeBaseCacheKey = makeCacheKey(
        task.nodeType,
        task.params,
        orderedInputHashes(task.nodeType, inputsByPort),
        runtimeMode
      );

      const outputCacheHits = new Map<string, RuntimeArtifactRef>();
      let allOutputsCached = true;
      for (const outputPort of spec.outputPorts) {
        const outputCacheKey = makeOutputCacheKey(nodeBaseCacheKey, outputPort.id);
        const hit = await prisma.cacheEntry.findUnique({
          where: { cacheKey: outputCacheKey },
          include: { artifact: true }
        });
        if (!hit?.artifact) {
          allOutputsCached = false;
          break;
        }
        outputCacheHits.set(outputPort.id, mapArtifact(hit.artifact));
      }

      if (allOutputsCached && outputCacheHits.size > 0) {
        for (const [outputId, artifact] of outputCacheHits.entries()) {
          producedByOutput.set(mapKey(task.nodeId, outputId), artifact);
          producedByArtifactId.set(artifact.artifactId, artifact);
        }
        const progress = Math.round(((i + 1) / total) * 100);
        await updateRun(input.runId, {
          progress,
          logs: appendLog(
            currentRun?.logs ?? "",
            `[${now}] ${task.nodeId} cache-hit mode=${runtimeMode ?? "default"} outputs=${[
              ...outputCacheHits.keys()
            ].join(",")}`
          )
        });
        continue;
      }

      const result = await runner.executeNode({
        projectId: input.projectId,
        runId: input.runId,
        nodeId: task.nodeId,
        nodeType: task.nodeType,
        params: task.params,
        inputs: inputsByPort,
        mode: runtimeMode,
        warnings: runtimeWarnings,
        loadInputBuffer: async (artifact) => getObjectBuffer(artifact.storageKey)
      });

      const outputs = result.outputs.filter((output) => spec.outputPorts.some((port) => port.id === output.outputId));
      if (outputs.length === 0) {
        throw new Error(`Node ${task.nodeId} produced no outputs`);
      }

      for (const output of outputs) {
        const outputPort = spec.outputPorts.find((port) => port.id === output.outputId);
        const outputHidden = Boolean(output.hidden ?? outputPort?.hidden);
        const outputHash = stableHashForOutput(output.buffer);
        const created = await prisma.artifact.create({
          data: {
            runId: input.runId,
            projectId: input.projectId,
            nodeId: task.nodeId,
            kind: output.kind,
            mimeType: output.mimeType,
            byteSize: output.buffer.length,
            hash: outputHash,
            storageKey: "pending",
            previewStorageKey: null,
            meta: {
              ...(output.meta ?? {}),
              outputKey: output.outputId,
              hidden: outputHidden,
              mode: result.mode ?? runtimeMode ?? null,
              warnings: result.warnings ?? runtimeWarnings
            } as Prisma.InputJsonValue
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
            hash: outputHash
          }
        });
        const mapped = mapArtifact(artifact);
        producedByOutput.set(mapKey(task.nodeId, output.outputId), mapped);
        producedByArtifactId.set(mapped.artifactId, mapped);

        const outputCacheKey = makeOutputCacheKey(nodeBaseCacheKey, output.outputId);
        await prisma.cacheEntry.upsert({
          where: { cacheKey: outputCacheKey },
          create: {
            projectId: input.projectId,
            cacheKey: outputCacheKey,
            artifactId: artifact.id
          },
          update: {
            artifactId: artifact.id
          }
        });
      }

      const progress = Math.round(((i + 1) / total) * 100);
      const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
      await updateRun(input.runId, {
        progress,
        logs: appendLog(
          latestRun?.logs ?? "",
          `[${now}] ${task.nodeId} executed mode=${result.mode ?? runtimeMode ?? "default"} outputs=${outputs
            .map((output) => output.outputId)
            .join(",")}${(result.warnings ?? runtimeWarnings).length ? ` warnings=${(result.warnings ?? runtimeWarnings).join(" | ")}` : ""}`
        )
      });
    }

    const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
    await updateRun(input.runId, {
      status: "success",
      progress: 100,
      finishedAt: new Date(),
      logs: appendLog(latestRun?.logs ?? "", `[${new Date().toISOString()}] Run finished`)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution error";
    const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
    const status: RunStatus = message.toLowerCase().includes("canceled") ? "canceled" : "error";
    await updateRun(input.runId, {
      status,
      finishedAt: new Date(),
      logs: appendLog(latestRun?.logs ?? "", `[${new Date().toISOString()}] ERROR: ${message}`)
    });
    throw error;
  }
}
