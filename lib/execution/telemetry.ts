import { randomUUID } from "crypto";

import { Prisma, RunStatus } from "@prisma/client";

import { prisma } from "@/lib/db";

export interface RunEventInput {
  runId: string;
  projectId: string;
  graphId: string;
  userId?: string | null;
  eventType: string;
  status?: RunStatus | null;
  nodeId?: string | null;
  nodeType?: string | null;
  message?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface StartedRunStep {
  id: string;
  startedAt: Date;
}

export interface StartRunStepInput {
  runId: string;
  projectId: string;
  graphId: string;
  userId?: string | null;
  nodeId: string;
  nodeType: string;
  stepCode?: string | null;
  stepLabel?: string | null;
  attempt?: number | null;
  sequence: number;
  inputSummary?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface CompleteRunStepInput {
  step: StartedRunStep | null;
  status: Extract<RunStatus, "success" | "error" | "canceled">;
  cacheHit?: boolean | null;
  outputSummary?: string | null;
  errorMessage?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordRunEvent(input: RunEventInput) {
  const metadataValue =
    input.metadata === undefined
      ? Prisma.sql`NULL`
      : Prisma.sql`CAST(${JSON.stringify(input.metadata)} AS jsonb)`;
  const statusValue =
    input.status === undefined || input.status === null
      ? Prisma.sql`NULL`
      : Prisma.sql`CAST(${input.status} AS "RunStatus")`;
  try {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "RunEvent"
          ("id","runId","projectId","graphId","userId","eventType","status","nodeId","nodeType","message","metadata","createdAt")
        VALUES
          (${randomUUID()}, ${input.runId}, ${input.projectId}, ${input.graphId}, ${input.userId ?? null},
           ${input.eventType}, ${statusValue}, ${input.nodeId ?? null}, ${input.nodeType ?? null},
           ${input.message ?? null}, ${metadataValue}, NOW())
      `
    );
  } catch (error) {
    console.warn("[run-telemetry] failed to record run event", {
      runId: input.runId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function startRunStep(input: StartRunStepInput): Promise<StartedRunStep | null> {
  const metadataValue =
    input.metadata === undefined
      ? Prisma.sql`NULL`
      : Prisma.sql`CAST(${JSON.stringify(input.metadata)} AS jsonb)`;
  const runningStatus = Prisma.sql`CAST(${"running"} AS "RunStatus")`;
  const resolvedAttempt =
    Number.isFinite(Number(input.attempt)) && Number(input.attempt) > 0 ? Math.floor(Number(input.attempt)) : 1;
  const resolvedStepCode =
    typeof input.stepCode === "string" && input.stepCode.trim().length > 0 ? input.stepCode.trim() : null;
  const resolvedStepLabel =
    typeof input.stepLabel === "string" && input.stepLabel.trim().length > 0 ? input.stepLabel.trim() : null;
  try {
    const created = await prisma.$queryRaw<Array<{ id: string; startedAt: Date }>>(
      Prisma.sql`
        INSERT INTO "RunStep"
          ("id","runId","projectId","graphId","userId","nodeId","nodeType","stepCode","stepLabel","attempt","sequence","status","startedAt","inputSummary","metadata","createdAt","updatedAt")
        VALUES
          (${randomUUID()}, ${input.runId}, ${input.projectId}, ${input.graphId}, ${input.userId ?? null},
           ${input.nodeId}, ${input.nodeType}, ${resolvedStepCode}, ${resolvedStepLabel}, ${resolvedAttempt},
           ${input.sequence}, ${runningStatus}, NOW(), ${input.inputSummary ?? null},
           ${metadataValue}, NOW(), NOW())
        RETURNING "id","startedAt"
      `
    );
    return created[0] ?? null;
  } catch (error) {
    console.warn("[run-telemetry] failed to start run step", {
      runId: input.runId,
      nodeId: input.nodeId,
      sequence: input.sequence,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export async function completeRunStep(input: CompleteRunStepInput) {
  if (!input.step) return;
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - input.step.startedAt.getTime());
  const metadataValue =
    input.metadata === undefined
      ? Prisma.sql`NULL`
      : Prisma.sql`CAST(${JSON.stringify(input.metadata)} AS jsonb)`;
  const statusValue = Prisma.sql`CAST(${input.status} AS "RunStatus")`;

  try {
    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "RunStep"
        SET
          "status" = ${statusValue},
          "finishedAt" = ${finishedAt},
          "durationMs" = ${durationMs},
          "cacheHit" = ${input.cacheHit ?? null},
          "outputSummary" = ${input.outputSummary ?? null},
          "errorMessage" = ${input.errorMessage ?? null},
          "metadata" = ${metadataValue},
          "updatedAt" = NOW()
        WHERE "id" = ${input.step.id}
      `
    );
  } catch (error) {
    console.warn("[run-telemetry] failed to complete run step", {
      stepId: input.step.id,
      status: input.status,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function closeOpenRunSteps(input: {
  runId: string;
  status: Extract<RunStatus, "error" | "canceled">;
  errorMessage?: string | null;
}) {
  const finishedAt = new Date();
  const statusValue = Prisma.sql`CAST(${input.status} AS "RunStatus")`;
  const runningStatus = Prisma.sql`CAST(${"running"} AS "RunStatus")`;
  try {
    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "RunStep"
        SET
          "status" = ${statusValue},
          "finishedAt" = ${finishedAt},
          "errorMessage" = ${input.errorMessage ?? null},
          "updatedAt" = NOW()
        WHERE "runId" = ${input.runId} AND "status" = ${runningStatus}
      `
    );
  } catch (error) {
    console.warn("[run-telemetry] failed to close open run steps", {
      runId: input.runId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
