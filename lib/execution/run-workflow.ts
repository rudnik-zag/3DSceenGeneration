import { ArtifactKind, Prisma, RunStatus } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";

import { prisma } from "@/lib/db";
import { ResolvedArtifactInput } from "@/lib/execution/contracts";
import { MockModelRunner, stableHashForOutput } from "@/lib/execution/mock-runner";
import { artifactTypeFromArtifactKind, normalizeArtifactType } from "@/lib/graph/artifact-types";
import { makeCacheKey, makeOutputCacheKey } from "@/lib/graph/cache";
import { mergeNodeParamsWithDefaults, nodeSpecRegistry } from "@/lib/graph/node-specs";
import { getPipelineTemplateByNodeType, getPipelineTemplateExecutionOrder } from "@/lib/graph/pipeline-templates";
import { buildExecutionPlan, parseGraphDocument } from "@/lib/graph/plan";
import { artifactPreviewStorageKey, artifactStorageKey } from "@/lib/storage/keys";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { getObjectBuffer, putObjectToStorage } from "@/lib/storage/s3";
import { ArtifactType, NodeArtifactRef, WorkflowNodeType } from "@/types/workflow";

export interface RunWorkflowInput {
  projectId: string;
  graphId: string;
  runId: string;
  startNodeId?: string;
  forceNodeIds?: string[];
}

const runner = new MockModelRunner();

interface RuntimeArtifactRef extends ResolvedArtifactInput {
  createdAt: Date;
  previewStorageKey: string | null;
}

function inferImageMimeTypeFromPath(value: string) {
  const lowered = value.toLowerCase();
  if (lowered.endsWith(".png")) return "image/png";
  if (lowered.endsWith(".webp")) return "image/webp";
  if (lowered.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function inferArtifactKindFromMime(mimeType: string): ArtifactKind {
  if (mimeType.includes("png") || mimeType.includes("jpeg") || mimeType.includes("jpg") || mimeType.includes("webp") || mimeType.includes("svg")) {
    return "image";
  }
  return "json";
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
  const artifactType = artifactTypeFromArtifactKind(artifact.kind, meta);
  const ref: NodeArtifactRef = {
    id: artifact.id,
    type: artifactType,
    name: outputId,
    mimeType: artifact.mimeType,
    storageKey: artifact.storageKey,
    metadata: meta,
    producerNodeId: artifact.nodeId,
    createdAt: artifact.createdAt.toISOString()
  };
  return {
    artifactId: artifact.id,
    nodeId: artifact.nodeId,
    outputId,
    kind: artifact.kind,
    artifactType,
    hash: artifact.hash,
    mimeType: artifact.mimeType,
    storageKey: artifact.storageKey,
    byteSize: artifact.byteSize,
    meta,
    ref,
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

function orderedInputSignatures(nodeType: WorkflowNodeType, inputsByPort: Record<string, RuntimeArtifactRef[]>) {
  const spec = nodeSpecRegistry[nodeType];
  const ordered: string[] = [];
  for (const port of spec.inputPorts) {
    const entries = [...(inputsByPort[port.id] ?? [])].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    for (const entry of entries) {
      ordered.push(`${entry.artifactId}:${entry.hash}`);
    }
  }
  return ordered;
}

function formatInputSummary(inputsByPort: Record<string, RuntimeArtifactRef[]>) {
  const ports = Object.keys(inputsByPort).sort((a, b) => a.localeCompare(b));
  if (ports.length === 0) return "none";
  return ports
    .map((port) => {
      const entries = inputsByPort[port] ?? [];
      if (entries.length === 0) return `${port}=[]`;
      const value = entries
        .map((entry) => `${entry.nodeId}:${entry.outputId}:${entry.kind}:${entry.artifactId.slice(0, 8)}`)
        .join(",");
      return `${port}=[${value}]`;
    })
    .join(" ");
}

function parseDescriptorMeta(artifact?: RuntimeArtifactRef | null) {
  if (!artifact) {
    return {
      sourceImageArtifactId: null as string | null,
      sourceImageHash: null as string | null,
      sourceImagePath: null as string | null,
      sourceImageStorageKey: null as string | null
    };
  }
  const sourceImageArtifactId =
    typeof artifact.meta.sourceImageArtifactId === "string" ? artifact.meta.sourceImageArtifactId : null;
  const sourceImageHash = typeof artifact.meta.sourceImageHash === "string" ? artifact.meta.sourceImageHash : null;
  const sourceImagePath =
    typeof artifact.meta.sourceImagePath === "string"
      ? artifact.meta.sourceImagePath
      : typeof artifact.meta.image_path === "string"
        ? artifact.meta.image_path
        : null;
  const sourceImageStorageKey =
    typeof artifact.meta.sourceImageStorageKey === "string" ? artifact.meta.sourceImageStorageKey : null;
  return { sourceImageArtifactId, sourceImageHash, sourceImagePath, sourceImageStorageKey };
}

async function parseDescriptorPayload(artifact: RuntimeArtifactRef | null) {
  if (!artifact || artifact.kind !== "json") return null;
  try {
    const raw = await getObjectBuffer(artifact.storageKey);
    const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

async function createRuntimeArtifactFromLocalPath(params: {
  nodeId: string;
  outputId: string;
  filePath: string;
  fallbackArtifactIdPrefix: string;
}) {
  const buffer = await fs.readFile(params.filePath);
  const hash = stableHashForOutput(buffer);
  const mimeType = inferImageMimeTypeFromPath(params.filePath);
  const kind = inferArtifactKindFromMime(mimeType);
  const artifactType: ArtifactType = kind === "image" ? "Image" : "JsonData";
  return {
    artifactId: `${params.fallbackArtifactIdPrefix}-${hash.slice(0, 10)}`,
    nodeId: params.nodeId,
    outputId: params.outputId,
    kind,
    artifactType,
    hash,
    mimeType,
    storageKey: params.filePath,
    byteSize: buffer.length,
    meta: {
      outputKey: params.outputId,
      artifactType,
      sourcePath: params.filePath
    },
    ref: {
      id: `${params.fallbackArtifactIdPrefix}-${hash.slice(0, 10)}`,
      type: artifactType,
      name: params.outputId,
      mimeType,
      storageKey: params.filePath,
      metadata: {
        outputKey: params.outputId,
        artifactType,
        sourcePath: params.filePath
      },
      producerNodeId: params.nodeId,
      createdAt: new Date().toISOString()
    },
    createdAt: new Date(),
    previewStorageKey: null
  } as RuntimeArtifactRef;
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
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, name: true }
    });
    const projectSlug = resolveProjectStorageSlug({
      projectName: project?.name,
      projectId: input.projectId
    });

    const graph = await prisma.graph.findUnique({ where: { id: input.graphId } });
    if (!graph) {
      throw new Error(`Graph ${input.graphId} not found`);
    }

    const document = parseGraphDocument(graph.graphJson);
    const documentNodeById = new Map(document.nodes.map((node) => [node.id, node]));
    const plan = buildExecutionPlan(document, input.startNodeId);
    const producedByOutput = new Map<string, RuntimeArtifactRef>();
    const producedByArtifactId = new Map<string, RuntimeArtifactRef>();
    const total = Math.max(1, plan.tasks.length);

    for (let i = 0; i < plan.tasks.length; i += 1) {
      const task = plan.tasks[i];
      const spec = nodeSpecRegistry[task.nodeType];
      const resolvedParams = mergeNodeParamsWithDefaults(task.nodeType, task.params);
      const now = new Date().toISOString();
      const forcedNodeSet = new Set(input.forceNodeIds ?? []);
      const shouldBypassCache = forcedNodeSet.has(task.nodeId);
      const currentRun = await prisma.run.findUnique({ where: { id: input.runId } });
      if (currentRun?.status === "canceled") {
        throw new Error("Run canceled by user");
      }

      const inputsByPort: Record<string, RuntimeArtifactRef[]> = {};
      for (const binding of task.inputBindings) {
        const produced = producedByOutput.get(mapKey(binding.sourceNodeId, binding.sourceOutputId));
        let resolved =
          produced ?? (await findLatestArtifactByNodeOutput(input.projectId, binding.sourceNodeId, binding.sourceOutputId));

        if (!resolved) {
          const sourceNode = documentNodeById.get(binding.sourceNodeId);
          const sourceStorageKey =
            sourceNode?.type === "input.image" &&
            sourceNode?.data?.params &&
            typeof sourceNode.data.params.storageKey === "string"
              ? sourceNode.data.params.storageKey
              : "";

          if (sourceNode?.type === "input.image" && binding.sourceOutputId === "image" && sourceStorageKey) {
            const sourceBuffer = await getObjectBuffer(sourceStorageKey);
            const sourceHash = stableHashForOutput(sourceBuffer);
            const filename =
              typeof sourceNode.data?.params?.filename === "string" && sourceNode.data.params.filename.length > 0
                ? sourceNode.data.params.filename
                : sourceStorageKey.split("/").pop() ?? "image.jpg";
            resolved = {
              artifactId: `source-${binding.sourceNodeId}-${sourceHash.slice(0, 10)}`,
              nodeId: binding.sourceNodeId,
              outputId: "image",
              kind: "image",
              artifactType: "Image",
              hash: sourceHash,
              mimeType: inferImageMimeTypeFromPath(filename),
              storageKey: sourceStorageKey,
              byteSize: sourceBuffer.length,
              meta: {
                outputKey: "image",
                artifactType: "Image",
                filename,
                sourceStorageKey
              },
              ref: {
                id: `source-${binding.sourceNodeId}-${sourceHash.slice(0, 10)}`,
                type: "Image",
                name: "image",
                mimeType: inferImageMimeTypeFromPath(filename),
                storageKey: sourceStorageKey,
                metadata: {
                  outputKey: "image",
                  artifactType: "Image",
                  filename,
                  sourceStorageKey
                },
                producerNodeId: binding.sourceNodeId,
                createdAt: new Date().toISOString()
              },
              createdAt: new Date(),
              previewStorageKey: null
            };
            producedByOutput.set(mapKey(binding.sourceNodeId, "image"), resolved);
            producedByArtifactId.set(resolved.artifactId, resolved);
          }
        }

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
        const directImage = inputsByPort.image?.[0] ?? null;
        const descriptorInput =
          inputsByPort.descriptor?.[0] ?? inputsByPort.boxes?.[0] ?? inputsByPort.boxesConfig?.[0] ?? null;
        const modeParam =
          typeof resolvedParams.mode === "string" && ["guided", "full", "auto"].includes(resolvedParams.mode)
            ? resolvedParams.mode
            : "auto";
        runtimeMode = modeParam === "auto" ? (descriptorInput ? "guided" : "full") : modeParam;

        if (runtimeMode === "guided" && !descriptorInput) {
          throw new Error("Requires ObjectDetection descriptor JSON input.");
        }

        let effectiveImage = directImage;
        let sourceImageHash: string | null = null;
        if (descriptorInput) {
          const descriptorMeta = parseDescriptorMeta(descriptorInput);
          sourceImageHash = descriptorMeta.sourceImageHash;

          if (!effectiveImage && descriptorMeta.sourceImageStorageKey) {
            try {
              const sourceBuffer = await getObjectBuffer(descriptorMeta.sourceImageStorageKey);
              const sourceHash = stableHashForOutput(sourceBuffer);
              effectiveImage = {
                artifactId: `source-storage-${task.nodeId}-${sourceHash.slice(0, 10)}`,
                nodeId: task.nodeId,
                outputId: "image",
                kind: "image",
                artifactType: "Image",
                hash: sourceHash,
                mimeType: inferImageMimeTypeFromPath(descriptorMeta.sourceImageStorageKey),
                storageKey: descriptorMeta.sourceImageStorageKey,
                byteSize: sourceBuffer.length,
                meta: {
                  outputKey: "image",
                  artifactType: "Image",
                  sourceStorageKey: descriptorMeta.sourceImageStorageKey
                },
                ref: {
                  id: `source-storage-${task.nodeId}-${sourceHash.slice(0, 10)}`,
                  type: "Image",
                  name: "image",
                  mimeType: inferImageMimeTypeFromPath(descriptorMeta.sourceImageStorageKey),
                  storageKey: descriptorMeta.sourceImageStorageKey,
                  metadata: {
                    outputKey: "image",
                    artifactType: "Image",
                    sourceStorageKey: descriptorMeta.sourceImageStorageKey
                  },
                  producerNodeId: task.nodeId,
                  createdAt: new Date().toISOString()
                },
                createdAt: new Date(),
                previewStorageKey: null
              };
            } catch {
              // Continue with other fallback paths.
            }
          }

          if (!effectiveImage && descriptorMeta.sourceImageArtifactId) {
            const sourcedImage =
              producedByArtifactId.get(descriptorMeta.sourceImageArtifactId) ??
              (await findArtifactById(input.projectId, descriptorMeta.sourceImageArtifactId));
            if (sourcedImage) {
              producedByArtifactId.set(sourcedImage.artifactId, sourcedImage);
              effectiveImage = sourcedImage;
            }
          }

          if (!effectiveImage && descriptorMeta.sourceImagePath) {
            try {
              await fs.access(descriptorMeta.sourceImagePath);
              effectiveImage = await createRuntimeArtifactFromLocalPath({
                nodeId: task.nodeId,
                outputId: "image",
                filePath: descriptorMeta.sourceImagePath,
                fallbackArtifactIdPrefix: "source-path"
              });
            } catch {
              // Continue with JSON payload fallback.
            }
          }

          if (!effectiveImage) {
            const boxesPayload = await parseDescriptorPayload(descriptorInput);
            const imagePath =
              boxesPayload && typeof boxesPayload.image_path === "string"
                ? boxesPayload.image_path
                : boxesPayload && typeof boxesPayload.sourceImagePath === "string"
                  ? boxesPayload.sourceImagePath
                  : boxesPayload && typeof boxesPayload.source_image_path === "string"
                    ? boxesPayload.source_image_path
                    : null;

            if (imagePath) {
              try {
                await fs.access(imagePath);
                effectiveImage = await createRuntimeArtifactFromLocalPath({
                  nodeId: task.nodeId,
                  outputId: "image",
                  filePath: imagePath,
                  fallbackArtifactIdPrefix: "source-json-path"
                });
              } catch {
                // Keep failing flow below.
              }
            }
          }

          inputsByPort.descriptor = [descriptorInput];
          inputsByPort.boxes = [descriptorInput];
          inputsByPort.boxesConfig = [descriptorInput];
        }

        if (directImage && sourceImageHash && directImage.hash !== sourceImageHash) {
          runtimeWarnings.push("Descriptor input image hash differs from direct image input. Using direct image input.");
        }

        if (!effectiveImage) {
          throw new Error("No input image provided and config JSON does not contain an image path.");
        }
        inputsByPort.image = [effectiveImage];
      }

      for (const requiredPort of requiredInputPorts(task.nodeType)) {
        if (!inputsByPort[requiredPort] || inputsByPort[requiredPort].length === 0) {
          throw new Error(`Node ${task.nodeId} missing required input "${requiredPort}"`);
        }
      }

      const inputSummary = formatInputSummary(inputsByPort);
      console.log(`[worker] node=${task.nodeId} inputs ${inputSummary}`);

      if (task.nodeType === "input.image") {
        const storageKey = typeof resolvedParams.storageKey === "string" ? resolvedParams.storageKey : "";
        if (storageKey) {
          const sourceBuffer = await getObjectBuffer(storageKey);
          const sourceHash = stableHashForOutput(sourceBuffer);
          const filename =
            typeof resolvedParams.filename === "string" && resolvedParams.filename.length > 0
              ? resolvedParams.filename
              : storageKey.split("/").pop() ?? "image.jpg";
          const sourceArtifact: RuntimeArtifactRef = {
            artifactId: `source-${task.nodeId}-${sourceHash.slice(0, 10)}`,
            nodeId: task.nodeId,
            outputId: "image",
            kind: "image",
            artifactType: "Image",
            hash: sourceHash,
            mimeType: inferImageMimeTypeFromPath(filename),
            storageKey,
            byteSize: sourceBuffer.length,
            meta: {
              outputKey: "image",
              artifactType: "Image",
              filename,
              sourceStorageKey: storageKey
            },
            ref: {
              id: `source-${task.nodeId}-${sourceHash.slice(0, 10)}`,
              type: "Image",
              name: "image",
              mimeType: inferImageMimeTypeFromPath(filename),
              storageKey,
              metadata: {
                outputKey: "image",
                artifactType: "Image",
                filename,
                sourceStorageKey: storageKey
              },
              producerNodeId: task.nodeId,
              createdAt: new Date().toISOString()
            },
            createdAt: new Date(),
            previewStorageKey: null
          };
          producedByOutput.set(mapKey(task.nodeId, "image"), sourceArtifact);
          producedByArtifactId.set(sourceArtifact.artifactId, sourceArtifact);
          console.log(
            `[worker] node=${task.nodeId} outputs image:image:${storageKey}`
          );

          const progress = Math.round(((i + 1) / total) * 100);
          await updateRun(input.runId, {
            progress,
            logs: appendLog(
              currentRun?.logs ?? "",
              `[${now}] ${task.nodeId} source-resolved storageKey=${storageKey}`
            )
          });
          continue;
        }
      }

      const nodeBaseCacheKey = makeCacheKey(
        task.nodeType,
        resolvedParams,
        orderedInputSignatures(task.nodeType, inputsByPort),
        runtimeMode
      );

      const outputCacheHits = new Map<string, RuntimeArtifactRef>();
      let allOutputsCached = !shouldBypassCache;
      if (!shouldBypassCache) {
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
      }

      if (allOutputsCached && outputCacheHits.size > 0 && !shouldBypassCache) {
        const cacheOutputs: string[] = [];
        for (const [outputId, artifact] of outputCacheHits.entries()) {
          producedByOutput.set(mapKey(task.nodeId, outputId), artifact);
          producedByArtifactId.set(artifact.artifactId, artifact);
          cacheOutputs.push(`${outputId}:${artifact.kind}:${artifact.storageKey}`);
        }
        if (cacheOutputs.length > 0) {
          console.log(`[worker] node=${task.nodeId} outputs(cache-hit) ${cacheOutputs.join(" | ")}`);
        }
        const progress = Math.round(((i + 1) / total) * 100);
        await updateRun(input.runId, {
          progress,
          logs: appendLog(
            currentRun?.logs ?? "",
            `[${now}] ${task.nodeId} cache-hit mode=${runtimeMode ?? "default"} outputs=${[
              ...outputCacheHits.keys()
            ].join(",")} inputs=${inputSummary} stored=${cacheOutputs.join(" | ")}`
          )
        });
        continue;
      }

      if (shouldBypassCache) {
        await updateRun(input.runId, {
          logs: appendLog(
            currentRun?.logs ?? "",
            `[${now}] ${task.nodeId} cache-bypass forced`
          )
        });
      }

      const template = getPipelineTemplateByNodeType(task.nodeType);
      if (template) {
        const debugInternalExecution = process.env.WORKFLOW_DEBUG_INTERNAL === "true";
        const internalProduced = new Map<string, RuntimeArtifactRef>();
        const internalNodeById = new Map(template.internalGraph.nodes.map((node) => [node.id, node]));
        const internalExecutionOrder = getPipelineTemplateExecutionOrder(template);
        const wrapperOutputs: RuntimeArtifactRef[] = [];

        for (const internalNodeId of internalExecutionOrder) {
          const internalNode = internalNodeById.get(internalNodeId);
          if (!internalNode) {
            throw new Error(`Template ${template.id} missing internal node ${internalNodeId}`);
          }
          const internalNodeRuntimeId = `${task.nodeId}::${template.id}::${internalNodeId}`;
          const internalSpec = nodeSpecRegistry[internalNode.type];
          const internalParams = mergeNodeParamsWithDefaults(internalNode.type, internalNode.params ?? {});

          for (const paramBinding of template.exposedParams) {
            if (paramBinding.internalNodeId !== internalNodeId) continue;
            const value = resolvedParams[paramBinding.exposedParamKey];
            if (value !== undefined) {
              let mappedValue: unknown = value;
              if (
                paramBinding.exposedParamKey === "SceneMaskExecution" &&
                paramBinding.internalParamKey === "runAllMasksInOneProcess"
              ) {
                if (typeof value === "boolean") {
                  mappedValue = value;
                } else if (value === "per_mask" || value === "Per mask") {
                  mappedValue = false;
                } else {
                  mappedValue = true;
                }
              }
              internalParams[paramBinding.internalParamKey] = mappedValue;
            }
          }

          const internalInputsByPort: Record<string, RuntimeArtifactRef[]> = {};

          for (const inputBinding of template.exposedInputs) {
            if (inputBinding.internalNodeId !== internalNodeId) continue;
            const exposedInputs = inputsByPort[inputBinding.exposedInputId] ?? [];
            if (exposedInputs.length === 0) continue;
            internalInputsByPort[inputBinding.internalInputId] = [
              ...(internalInputsByPort[inputBinding.internalInputId] ?? []),
              ...exposedInputs
            ];
          }

          for (const edge of template.internalGraph.edges) {
            if (edge.targetNodeId !== internalNodeId) continue;
            const produced = internalProduced.get(`${edge.sourceNodeId}:${edge.sourceOutputId}`);
            if (!produced) continue;
            internalInputsByPort[edge.targetInputId] = [...(internalInputsByPort[edge.targetInputId] ?? []), produced];
          }

          let internalRuntimeMode: string | undefined;
          const internalWarnings: string[] = [];
          if (internalNode.type === "model.sam2") {
            const directImage = internalInputsByPort.image?.[0] ?? null;
            const descriptor =
              internalInputsByPort.descriptor?.[0] ??
              internalInputsByPort.boxes?.[0] ??
              internalInputsByPort.boxesConfig?.[0] ??
              null;
            const modeParam =
              typeof internalParams.mode === "string" && ["guided", "full", "auto"].includes(internalParams.mode)
                ? internalParams.mode
                : "auto";
            internalRuntimeMode = modeParam === "auto" ? (descriptor ? "guided" : "full") : modeParam;

            if (internalRuntimeMode === "guided" && !descriptor) {
              throw new Error("Template SegmentScene requires ObjectDetection descriptor input in guided mode.");
            }
            if (descriptor) {
              internalInputsByPort.descriptor = [descriptor];
              internalInputsByPort.boxes = [descriptor];
              internalInputsByPort.boxesConfig = [descriptor];
            }
            if (!directImage) {
              throw new Error("Template SegmentScene requires image input.");
            }
            internalInputsByPort.image = [directImage];
          }

          for (const requiredPort of requiredInputPorts(internalNode.type)) {
            if (!internalInputsByPort[requiredPort] || internalInputsByPort[requiredPort].length === 0) {
              throw new Error(`Template node ${internalNodeId} missing required input "${requiredPort}"`);
            }
          }

          const internalCacheBaseKey = makeCacheKey(
            internalNode.type,
            internalParams,
            orderedInputSignatures(internalNode.type, internalInputsByPort),
            internalRuntimeMode
          );
          const internalCacheHits = new Map<string, RuntimeArtifactRef>();
          let internalAllCached = !shouldBypassCache;

          if (!shouldBypassCache) {
            for (const outputPort of internalSpec.outputPorts) {
              const outputCacheKey = makeOutputCacheKey(internalCacheBaseKey, outputPort.id);
              const hit = await prisma.cacheEntry.findUnique({
                where: { cacheKey: outputCacheKey },
                include: { artifact: true }
              });
              if (!hit?.artifact) {
                internalAllCached = false;
                break;
              }
              internalCacheHits.set(outputPort.id, mapArtifact(hit.artifact));
            }
          }

          if (internalAllCached && internalCacheHits.size > 0 && !shouldBypassCache) {
            for (const [outputId, artifact] of internalCacheHits.entries()) {
              internalProduced.set(`${internalNodeId}:${outputId}`, artifact);
              producedByArtifactId.set(artifact.artifactId, artifact);
            }
            if (debugInternalExecution) {
              const latest = await prisma.run.findUnique({ where: { id: input.runId } });
              await updateRun(input.runId, {
                logs: appendLog(
                  latest?.logs ?? "",
                  `[${now}] ${task.nodeId} template-cache-hit internal=${internalNodeId} outputs=${[
                    ...internalCacheHits.keys()
                  ].join(",")}`
                )
              });
            }
            continue;
          }

          const internalResult = await runner.executeNode({
            projectId: input.projectId,
            projectSlug,
            runId: input.runId,
            nodeId: internalNodeRuntimeId,
            nodeType: internalNode.type,
            params: internalParams,
            inputs: internalInputsByPort,
            mode: internalRuntimeMode,
            warnings: internalWarnings,
            loadInputBuffer: async (artifact) => {
              if (path.isAbsolute(artifact.storageKey)) {
                try {
                  return await fs.readFile(artifact.storageKey);
                } catch {
                  // Fall back to object storage.
                }
              }
              return getObjectBuffer(artifact.storageKey);
            }
          });

          const internalOutputs = internalResult.outputs.filter((output) =>
            internalSpec.outputPorts.some((port) => port.id === output.outputId)
          );
          if (internalOutputs.length === 0) {
            throw new Error(`Template internal node ${internalNodeId} produced no outputs`);
          }

          for (const output of internalOutputs) {
            const outputPort = internalSpec.outputPorts.find((port) => port.id === output.outputId);
            const outputArtifactType = normalizeArtifactType(
              output.artifactType ?? outputPort?.artifactType,
              artifactTypeFromArtifactKind(output.kind)
            );
            const outputHidden = true;
            const outputHash = stableHashForOutput(output.buffer);
            const created = await prisma.artifact.create({
              data: {
                runId: input.runId,
                projectId: input.projectId,
                nodeId: internalNodeRuntimeId,
                kind: output.kind,
                mimeType: output.mimeType,
                byteSize: output.buffer.length,
                hash: outputHash,
                storageKey: "pending",
                previewStorageKey: null,
                meta: {
                  ...(output.meta ?? {}),
                  outputKey: output.outputId,
                  artifactType: outputArtifactType,
                  hidden: outputHidden,
                  templateId: template.id,
                  templateNodeId: internalNodeId,
                  mode: internalResult.mode ?? internalRuntimeMode ?? null,
                  warnings: internalResult.warnings ?? internalWarnings
                } as Prisma.InputJsonValue
              }
            });

            const key = artifactStorageKey({
              projectSlug,
              projectId: input.projectId,
              runId: input.runId,
              nodeId: internalNodeRuntimeId,
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
                projectSlug,
                projectId: input.projectId,
                runId: input.runId,
                nodeId: internalNodeRuntimeId,
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
            internalProduced.set(`${internalNodeId}:${output.outputId}`, mapped);
            producedByArtifactId.set(mapped.artifactId, mapped);

            const internalOutputCacheKey = makeOutputCacheKey(internalCacheBaseKey, output.outputId);
            await prisma.cacheEntry.upsert({
              where: { cacheKey: internalOutputCacheKey },
              create: {
                projectId: input.projectId,
                cacheKey: internalOutputCacheKey,
                artifactId: artifact.id
              },
              update: {
                artifactId: artifact.id
              }
            });
          }

          if (debugInternalExecution) {
            const latest = await prisma.run.findUnique({ where: { id: input.runId } });
            await updateRun(input.runId, {
              logs: appendLog(
                latest?.logs ?? "",
                `[${now}] ${task.nodeId} template-executed internal=${internalNodeId} outputs=${internalOutputs
                  .map((output) => output.outputId)
                  .join(",")}`
              )
            });
          }
        }

        for (const outputBinding of template.exposedOutputs) {
          const internalOutput = internalProduced.get(
            `${outputBinding.internalNodeId}:${outputBinding.internalOutputId}`
          );
          if (!internalOutput) {
            throw new Error(
              `Template ${template.id} missing output ${outputBinding.internalNodeId}.${outputBinding.internalOutputId}`
            );
          }

          const outputPort = spec.outputPorts.find((port) => port.id === outputBinding.exposedOutputId);
          const outputArtifactType = normalizeArtifactType(
            outputPort?.artifactType,
            internalOutput.artifactType
          );
          const alias = await prisma.artifact.create({
            data: {
              runId: input.runId,
              projectId: input.projectId,
              nodeId: task.nodeId,
              kind: internalOutput.kind,
              mimeType: internalOutput.mimeType,
              byteSize: internalOutput.byteSize,
              hash: internalOutput.hash,
              storageKey: internalOutput.storageKey,
              previewStorageKey: internalOutput.previewStorageKey,
              meta: {
                ...(internalOutput.meta ?? {}),
                outputKey: outputBinding.exposedOutputId,
                artifactType: outputArtifactType,
                hidden: false,
                templateId: template.id,
                templateOutputSource: `${outputBinding.internalNodeId}.${outputBinding.internalOutputId}`,
                mode: runtimeMode ?? null
              } as Prisma.InputJsonValue
            }
          });
          const aliasMapped = mapArtifact(alias);
          wrapperOutputs.push(aliasMapped);
          producedByOutput.set(mapKey(task.nodeId, outputBinding.exposedOutputId), aliasMapped);
          producedByArtifactId.set(aliasMapped.artifactId, aliasMapped);

          const outputCacheKey = makeOutputCacheKey(nodeBaseCacheKey, outputBinding.exposedOutputId);
          await prisma.cacheEntry.upsert({
            where: { cacheKey: outputCacheKey },
            create: {
              projectId: input.projectId,
              cacheKey: outputCacheKey,
              artifactId: alias.id
            },
            update: {
              artifactId: alias.id
            }
          });
        }

        const progress = Math.round(((i + 1) / total) * 100);
        const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
        await updateRun(input.runId, {
          progress,
          logs: appendLog(
            latestRun?.logs ?? "",
            `[${now}] ${task.nodeId} executed mode=template outputs=${wrapperOutputs
              .map((output) => output.outputId)
              .join(",")} inputs=${inputSummary}`
          )
        });
        continue;
      }

      const result = await runner.executeNode({
        projectId: input.projectId,
        projectSlug,
        runId: input.runId,
        nodeId: task.nodeId,
        nodeType: task.nodeType,
        params: resolvedParams,
        inputs: inputsByPort,
        mode: runtimeMode,
        warnings: runtimeWarnings,
        loadInputBuffer: async (artifact) => {
          if (path.isAbsolute(artifact.storageKey)) {
            try {
              return await fs.readFile(artifact.storageKey);
            } catch {
              // Fall back to storage key lookup.
            }
          }
          return getObjectBuffer(artifact.storageKey);
        }
      });

      const outputs = result.outputs.filter((output) => spec.outputPorts.some((port) => port.id === output.outputId));
      if (outputs.length === 0) {
        throw new Error(`Node ${task.nodeId} produced no outputs`);
      }

      const storedOutputs: string[] = [];
      for (const output of outputs) {
        const outputPort = spec.outputPorts.find((port) => port.id === output.outputId);
        const outputHidden = Boolean(output.hidden ?? outputPort?.hidden);
        const outputArtifactType = normalizeArtifactType(
          output.artifactType ?? outputPort?.artifactType,
          artifactTypeFromArtifactKind(output.kind)
        );
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
              artifactType: outputArtifactType,
              hidden: outputHidden,
              mode: result.mode ?? runtimeMode ?? null,
              warnings: result.warnings ?? runtimeWarnings
            } as Prisma.InputJsonValue
          }
        });

        const key = artifactStorageKey({
          projectSlug,
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
            projectSlug,
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
        storedOutputs.push(`${output.outputId}:${output.kind}:${outputArtifactType}:${key}`);
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
      if (storedOutputs.length > 0) {
        console.log(`[worker] node=${task.nodeId} outputs ${storedOutputs.join(" | ")}`);
      }

      const progress = Math.round(((i + 1) / total) * 100);
      const latestRun = await prisma.run.findUnique({ where: { id: input.runId } });
      await updateRun(input.runId, {
        progress,
        logs: appendLog(
          latestRun?.logs ?? "",
          `[${now}] ${task.nodeId} executed mode=${result.mode ?? runtimeMode ?? "default"} outputs=${outputs
            .map((output) => output.outputId)
            .join(",")} inputs=${inputSummary} stored=${storedOutputs.join(" | ")}${(result.warnings ?? runtimeWarnings).length ? ` warnings=${(result.warnings ?? runtimeWarnings).join(" | ")}` : ""}`
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
