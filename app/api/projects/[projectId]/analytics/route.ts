import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { requireProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { toApiErrorResponse } from "@/lib/security/errors";

type StepStatus = "queued" | "running" | "success" | "error" | "canceled";

interface NodeSummary {
  nodeId: string;
  nodeType: string;
  totalSteps: number;
  successSteps: number;
  errorSteps: number;
  canceledSteps: number;
  runningSteps: number;
  queuedSteps: number;
  successRate: number;
  avgDurationMs: number | null;
}

interface RunStatusCountRow {
  status: StepStatus;
  _count: { _all: number };
}

interface CreatorCountRow {
  createdBy: string | null;
  _count: { _all: number };
}

interface StepAggregateRow {
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  countAll: number;
  avgDurationMs: number | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    await requireProjectAccess(projectId, "viewer");

    const [project, runStatusCountsRaw, creatorCountsRaw, stepRows, recentEvents] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          name: true,
          ownerId: true,
          owner: {
            select: { id: true, email: true, name: true }
          }
        }
      }),
      prisma.run.groupBy({
        by: ["status"],
        where: { projectId },
        _count: { _all: true }
      }),
      prisma.run.groupBy({
        by: ["createdBy"],
        where: { projectId },
        _count: { _all: true }
      }),
      prisma.$queryRaw<Array<StepAggregateRow>>(
        Prisma.sql`
          SELECT
            "nodeId",
            "nodeType",
            "status"::text AS "status",
            COUNT(*)::int AS "countAll",
            AVG("durationMs")::float AS "avgDurationMs"
          FROM "RunStep"
          WHERE "projectId" = ${projectId}
          GROUP BY "nodeId", "nodeType", "status"
        `
      ),
      prisma.$queryRaw(
        Prisma.sql`
          SELECT *
          FROM "RunEvent"
          WHERE "projectId" = ${projectId}
          ORDER BY "createdAt" DESC
          LIMIT 200
        `
      )
    ]);
    const runStatusCounts = runStatusCountsRaw as RunStatusCountRow[];
    const creatorCounts = creatorCountsRaw as CreatorCountRow[];

    const creatorIds = creatorCounts
      .map((entry) => entry.createdBy)
      .filter((value): value is string => Boolean(value));
    const creatorUsers = creatorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, email: true, name: true }
        })
      : [];
    const userById = new Map(creatorUsers.map((user) => [user.id, user]));

    const runSummary = {
      totalRuns: runStatusCounts.reduce((sum, row) => sum + row._count._all, 0),
      byStatus: Object.fromEntries(runStatusCounts.map((row) => [row.status, row._count._all]))
    };

    const creators = creatorCounts
      .map((entry) => {
        const user = entry.createdBy ? userById.get(entry.createdBy) : null;
        return {
          userId: entry.createdBy,
          runCount: entry._count._all,
          email: user?.email ?? null,
          name: user?.name ?? null
        };
      })
      .sort((a, b) => b.runCount - a.runCount);

    const nodeMap = new Map<string, NodeSummary>();
    const nodeDurationTotals = new Map<string, { weightedMs: number; count: number }>();
    for (const row of stepRows) {
      const key = `${row.nodeType}::${row.nodeId}`;
      const current =
        nodeMap.get(key) ??
        ({
          nodeId: row.nodeId,
          nodeType: row.nodeType,
          totalSteps: 0,
          successSteps: 0,
          errorSteps: 0,
          canceledSteps: 0,
          runningSteps: 0,
          queuedSteps: 0,
          successRate: 0,
          avgDurationMs: null
        } satisfies NodeSummary);

      current.totalSteps += row.countAll;
      const status = row.status as StepStatus;
      if (status === "success") current.successSteps += row.countAll;
      if (status === "error") current.errorSteps += row.countAll;
      if (status === "canceled") current.canceledSteps += row.countAll;
      if (status === "running") current.runningSteps += row.countAll;
      if (status === "queued") current.queuedSteps += row.countAll;

      if (status === "success" && typeof row.avgDurationMs === "number") {
        const existing = nodeDurationTotals.get(key) ?? { weightedMs: 0, count: 0 };
        existing.weightedMs += row.avgDurationMs * row.countAll;
        existing.count += row.countAll;
        nodeDurationTotals.set(key, existing);
      }

      current.successRate = current.totalSteps > 0 ? current.successSteps / current.totalSteps : 0;
      nodeMap.set(key, current);
    }

    for (const [key, summary] of nodeMap.entries()) {
      const duration = nodeDurationTotals.get(key);
      summary.avgDurationMs =
        duration && duration.count > 0 ? duration.weightedMs / duration.count : null;
      nodeMap.set(key, summary);
    }

    const nodeSummaries = [...nodeMap.values()].sort((a, b) => b.totalSteps - a.totalSteps);

    return NextResponse.json({
      project,
      runs: runSummary,
      runCreators: creators,
      nodeSummaries,
      recentEvents
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to read project analytics");
  }
}
