import { Prisma, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

import { resolveBillingStateForUser } from "@/lib/billing/entitlements";
import { RunCostEstimate, estimateRunTokenCost } from "@/lib/billing/pricing";
import { SubscriptionPlanKey, getPlanDefinition, isSubscriptionPlanKey } from "@/lib/billing/plans";
import { prisma } from "@/lib/db";
import { parseGraphDocument } from "@/lib/graph/plan";
import { HttpError } from "@/lib/security/errors";

function clampInt(value: number, min = 0) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.round(value));
}

function finalUsageStatus(status: "success" | "error" | "canceled") {
  if (status === "success") return "completed" as const;
  if (status === "canceled") return "canceled" as const;
  return "failed" as const;
}

function parseReservationSplit(metadata: Prisma.JsonValue | null | undefined) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { monthlyDebited: 0, purchasedDebited: 0 };
  }
  const record = metadata as Record<string, unknown>;
  return {
    monthlyDebited: clampInt(Number(record.monthlyDebited ?? 0)),
    purchasedDebited: clampInt(Number(record.purchasedDebited ?? 0))
  };
}

async function lockWalletRow(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "TokenWallet" WHERE "userId" = ${userId} FOR UPDATE`
  );
}

function debitSplit(input: {
  monthlyTokensRemaining: number;
  purchasedTokensRemaining: number;
  amount: number;
}) {
  const monthlyDebited = Math.min(input.monthlyTokensRemaining, input.amount);
  const purchasedDebited = input.amount - monthlyDebited;
  if (purchasedDebited > input.purchasedTokensRemaining) {
    throw new HttpError(402, "Insufficient token balance.", "insufficient_tokens");
  }
  return {
    monthlyDebited,
    purchasedDebited
  };
}

function assertRunEntitlements(input: {
  estimate: RunCostEstimate;
  state: Awaited<ReturnType<typeof resolveBillingStateForUser>>;
}) {
  const { entitlements } = input.state;
  if (input.estimate.includesSceneGeneration && !entitlements.canRunSceneGeneration) {
    throw new HttpError(403, "Your plan cannot run scene generation.", "plan_forbidden");
  }
  if (input.estimate.usesAdvancedNodes && !entitlements.canUseAdvancedNodes) {
    throw new HttpError(403, "Your plan does not allow advanced nodes.", "plan_forbidden");
  }
}

async function assertConcurrentRunLimit(input: {
  userId: string;
  maxConcurrentRuns: number;
}) {
  const inFlight = await prisma.run.count({
    where: {
      createdBy: input.userId,
      status: { in: ["queued", "running"] }
    }
  });
  if (inFlight >= input.maxConcurrentRuns) {
    throw new HttpError(
      429,
      `Concurrent run limit reached (${input.maxConcurrentRuns}).`,
      "run_limit_reached"
    );
  }
}

export async function estimateRunForUser(input: {
  userId: string;
  graphJson: unknown;
  startNodeId?: string;
}) {
  const state = await resolveBillingStateForUser(input.userId);
  const estimate = estimateRunTokenCost({
    graphJson: input.graphJson,
    startNodeId: input.startNodeId
  });
  assertRunEntitlements({ estimate, state });
  const availableTokens = state.wallet.monthlyTokensRemaining + state.wallet.purchasedTokensRemaining;
  return {
    state,
    estimate,
    canAfford: availableTokens >= estimate.estimatedTokenCost
  };
}

export async function createRunWithTokenReservation(input: {
  userId: string;
  projectId: string;
  graphId: string;
  graphJson: unknown;
  startNodeId?: string;
  logs: string;
}) {
  const { state, estimate, canAfford } = await estimateRunForUser({
    userId: input.userId,
    graphJson: input.graphJson,
    startNodeId: input.startNodeId
  });
  if (!canAfford) {
    throw new HttpError(402, "Insufficient token balance.", "insufficient_tokens");
  }
  await assertConcurrentRunLimit({
    userId: input.userId,
    maxConcurrentRuns: state.entitlements.maxConcurrentRuns
  });

  const result = await prisma.$transaction(async (tx) => {
    await lockWalletRow(tx, input.userId);
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: input.userId }
    });
    if (!wallet) {
      throw new HttpError(500, "Token wallet missing.", "wallet_missing");
    }

    const split = debitSplit({
      monthlyTokensRemaining: wallet.monthlyTokensRemaining,
      purchasedTokensRemaining: wallet.purchasedTokensRemaining,
      amount: estimate.estimatedTokenCost
    });

    const run = await tx.run.create({
      data: {
        projectId: input.projectId,
        graphId: input.graphId,
        createdBy: input.userId,
        status: "queued",
        logs: input.logs,
        progress: 0
      }
    });

    const usageEvent = await tx.usageEvent.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        runId: run.id,
        featureKey: estimate.featureKey,
        estimatedTokenCost: estimate.estimatedTokenCost,
        status: "reserved",
        metadata: {
          policyVersion: estimate.policyVersion,
          breakdown: estimate.breakdown,
          monthlyDebited: split.monthlyDebited,
          purchasedDebited: split.purchasedDebited
        } as Prisma.InputJsonValue
      }
    });

    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: {
        monthlyTokensRemaining: {
          decrement: split.monthlyDebited
        },
        purchasedTokensRemaining: {
          decrement: split.purchasedDebited
        }
      }
    });

    await tx.tokenTransaction.create({
      data: {
        userId: input.userId,
        projectId: input.projectId,
        runId: run.id,
        type: "debit",
        source: "usage",
        amount: estimate.estimatedTokenCost,
        description: `Reserved tokens for run ${run.id}`,
        metadata: {
          usageEventId: usageEvent.id,
          monthlyDebited: split.monthlyDebited,
          purchasedDebited: split.purchasedDebited,
          featureKey: estimate.featureKey
        } as Prisma.InputJsonValue
      }
    });

    return {
      run,
      usageEventId: usageEvent.id
    };
  });

  return {
    run: result.run,
    usageEventId: result.usageEventId,
    estimate,
    queuePriority: state.entitlements.queuePriority,
    availableTokensAfterReserve:
      state.wallet.monthlyTokensRemaining +
      state.wallet.purchasedTokensRemaining -
      estimate.estimatedTokenCost
  };
}

export async function finalizeRunUsage(input: {
  runId: string;
  status: "success" | "error" | "canceled";
  actualTokenCost?: number;
}) {
  const usageEvent = await prisma.usageEvent.findUnique({
    where: { runId: input.runId }
  });
  if (!usageEvent) return null;
  if (usageEvent.status !== "reserved") {
    return usageEvent;
  }

  const estimated = clampInt(usageEvent.estimatedTokenCost);
  const actual =
    input.status === "success"
      ? Math.min(estimated, clampInt(input.actualTokenCost ?? estimated))
      : 0;
  const refundAmount = Math.max(0, estimated - actual);
  const reservationSplit = parseReservationSplit(usageEvent.metadata);

  await prisma.$transaction(async (tx) => {
    await lockWalletRow(tx, usageEvent.userId);
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: usageEvent.userId }
    });
    if (!wallet) {
      throw new HttpError(500, "Token wallet missing.", "wallet_missing");
    }

    const refundMonthly = Math.min(refundAmount, reservationSplit.monthlyDebited);
    const refundPurchased = Math.max(0, refundAmount - refundMonthly);

    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: {
        monthlyTokensRemaining: refundMonthly > 0 ? { increment: refundMonthly } : undefined,
        purchasedTokensRemaining: refundPurchased > 0 ? { increment: refundPurchased } : undefined,
        totalTokensUsed: { increment: actual }
      }
    });

    if (refundAmount > 0) {
      await tx.tokenTransaction.create({
        data: {
          userId: usageEvent.userId,
          projectId: usageEvent.projectId,
          runId: usageEvent.runId,
          type: "refund",
          source: "usage",
          amount: refundAmount,
          description: `Usage refund for run ${usageEvent.runId ?? "unknown"}`,
          metadata: {
            refundMonthly,
            refundPurchased,
            estimated,
            actual
          } as Prisma.InputJsonValue
        }
      });
    }

    await tx.usageEvent.update({
      where: { id: usageEvent.id },
      data: {
        actualTokenCost: actual,
        status: finalUsageStatus(input.status),
        metadata: {
          ...(usageEvent.metadata && typeof usageEvent.metadata === "object" && !Array.isArray(usageEvent.metadata)
            ? (usageEvent.metadata as Record<string, unknown>)
            : {}),
          finalizedAt: new Date().toISOString(),
          finalStatus: input.status,
          refundAmount
        } as Prisma.InputJsonValue
      }
    });
  });

  return {
    estimated,
    actual,
    refundAmount
  };
}

export async function creditTokenPack(input: {
  userId: string;
  tokenAmount: number;
  description: string;
  metadata?: Record<string, unknown>;
}) {
  const amount = clampInt(input.tokenAmount);
  if (amount <= 0) {
    throw new HttpError(400, "Token amount must be positive.", "validation_error");
  }

  await resolveBillingStateForUser(input.userId);
  await prisma.$transaction(async (tx) => {
    await lockWalletRow(tx, input.userId);
    const wallet = await tx.tokenWallet.findUnique({
      where: { userId: input.userId }
    });
    if (!wallet) {
      throw new HttpError(500, "Token wallet missing.", "wallet_missing");
    }
    await tx.tokenWallet.update({
      where: { id: wallet.id },
      data: {
        purchasedTokensRemaining: { increment: amount }
      }
    });
    await tx.tokenTransaction.create({
      data: {
        userId: input.userId,
        type: "credit",
        source: "token_pack",
        amount,
        description: input.description,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
      }
    });
  });
}

export async function syncSubscriptionFromBilling(input: {
  userId: string;
  plan: SubscriptionPlanKey;
  status: SubscriptionStatus;
  billingProvider: string;
  billingCustomerId?: string | null;
  billingSubscriptionId?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  resetMonthlyAllowance?: boolean;
}) {
  if (!isSubscriptionPlanKey(input.plan)) {
    throw new HttpError(400, "Invalid subscription plan.", "validation_error");
  }

  const subscription = await prisma.subscription.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      plan: input.plan as SubscriptionPlan,
      status: input.status,
      billingProvider: input.billingProvider,
      billingCustomerId: input.billingCustomerId ?? null,
      billingSubscriptionId: input.billingSubscriptionId ?? null,
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd)
    },
    update: {
      plan: input.plan as SubscriptionPlan,
      status: input.status,
      billingProvider: input.billingProvider,
      billingCustomerId: input.billingCustomerId ?? null,
      billingSubscriptionId: input.billingSubscriptionId ?? null,
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd)
    }
  });

  if (input.resetMonthlyAllowance) {
    const allowance = getPlanDefinition(input.plan).entitlements.monthlyTokenAllowance;
    await resolveBillingStateForUser(input.userId);
    await prisma.$transaction(async (tx) => {
      await lockWalletRow(tx, input.userId);
      const wallet = await tx.tokenWallet.findUnique({
        where: { userId: input.userId }
      });
      if (!wallet) {
        throw new HttpError(500, "Token wallet missing.", "wallet_missing");
      }
      await tx.tokenWallet.update({
        where: { id: wallet.id },
        data: {
          monthlyTokensRemaining: allowance,
          monthlyAllowance: allowance,
          periodStart: input.currentPeriodStart ?? wallet.periodStart,
          periodEnd: input.currentPeriodEnd ?? wallet.periodEnd
        }
      });
      await tx.tokenTransaction.create({
        data: {
          userId: input.userId,
          type: "monthly_reset",
          source: "subscription",
          amount: allowance,
          description: `Monthly allowance reset (${input.plan})`,
          metadata: {
            source: "billing_sync"
          } as Prisma.InputJsonValue
        }
      });
    });
  }

  return subscription;
}

export async function getGraphForRunEstimation(graphId: string) {
  const graph = await prisma.graph.findUnique({
    where: { id: graphId },
    select: {
      id: true,
      projectId: true,
      graphJson: true
    }
  });
  if (!graph) {
    throw new HttpError(404, "Graph not found.", "graph_not_found");
  }
  parseGraphDocument(graph.graphJson);
  return graph;
}
