import { RunsPanel } from "@/components/layout/runs-panel";
import { prisma } from "@/lib/db";

export default async function RunsPage({
  params
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const runs = await prisma.run.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      graph: {
        select: {
          id: true,
          name: true,
          version: true
        }
      },
      artifacts: {
        select: {
          id: true,
          kind: true,
          nodeId: true
        },
        orderBy: { createdAt: "desc" }
      }
    }
  });

  return (
    <RunsPanel
      projectId={projectId}
      initialRuns={runs.map((run) => ({
        ...run,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        status: run.status as "queued" | "running" | "success" | "error" | "canceled"
      }))}
    />
  );
}
