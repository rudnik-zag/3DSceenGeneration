import { Prisma } from "@prisma/client";

export async function reserveNextRunNumber(tx: Prisma.TransactionClient, projectId: string) {
  const counter = await tx.projectRunCounter.upsert({
    where: { projectId },
    create: {
      projectId,
      nextRunNumber: 2
    },
    update: {
      nextRunNumber: {
        increment: 1
      }
    },
    select: {
      nextRunNumber: true
    }
  });

  return counter.nextRunNumber - 1;
}

export function formatRunFolderLabel(runNumber: number) {
  const normalized = Number.isFinite(runNumber) && runNumber > 0 ? Math.floor(runNumber) : 0;
  return `run_${String(normalized).padStart(4, "0")}`;
}

