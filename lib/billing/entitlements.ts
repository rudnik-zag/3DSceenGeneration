import { SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/security/errors";
import { PlanEntitlements, SubscriptionPlanKey, getPlanDefinition, planOrder } from "@/lib/billing/plans";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>(["active", "trialing"]);

function addMonths(start: Date, months: number) {
  const next = new Date(start);
  next.setMonth(next.getMonth() + months);
  return next;
}

function toPlanKey(plan: SubscriptionPlan): SubscriptionPlanKey {
  return plan as SubscriptionPlanKey;
}

function effectivePlanFromSubscription(input: {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
}): SubscriptionPlanKey {
  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(input.status)) {
    return "Free";
  }
  return toPlanKey(input.plan);
}

function applyAdminPlanOverride(input: {
  plan: SubscriptionPlanKey;
  email: string | null;
}) {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (!email) return input.plan;
  if (!env.BILLING_ADMIN_PRO_EMAILS.includes(email)) return input.plan;

  const currentRank = planOrder.indexOf(input.plan);
  const proRank = planOrder.indexOf("Pro");
  return currentRank >= proRank ? input.plan : "Pro";
}

export interface BillingState {
  subscription: {
    id: string;
    plan: SubscriptionPlanKey;
    status: SubscriptionStatus;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  };
  wallet: {
    id: string;
    monthlyTokensRemaining: number;
    purchasedTokensRemaining: number;
    totalTokensUsed: number;
    monthlyAllowance: number;
    periodStart: Date | null;
    periodEnd: Date | null;
    updatedAt: Date;
  };
  entitlements: PlanEntitlements;
  availableTokens: number;
}

async function ensureSubscriptionForUser(userId: string) {
  const now = new Date();
  let subscription = await prisma.subscription.findUnique({
    where: { userId }
  });
  if (!subscription) {
    subscription = await prisma.subscription.create({
      data: {
        userId,
        plan: "Free",
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: addMonths(now, 1),
        cancelAtPeriodEnd: false
      }
    });
  }
  return subscription;
}

function periodExpired(input: {
  now: Date;
  subscriptionPeriodEnd: Date | null;
  walletPeriodEnd: Date | null;
}) {
  const subscriptionEnd = input.subscriptionPeriodEnd ? input.subscriptionPeriodEnd.getTime() : 0;
  const walletEnd = input.walletPeriodEnd ? input.walletPeriodEnd.getTime() : 0;
  const effectiveEnd = Math.max(subscriptionEnd, walletEnd);
  return effectiveEnd > 0 && effectiveEnd <= input.now.getTime();
}

async function ensureWalletForUser(input: {
  userId: string;
  plan: SubscriptionPlanKey;
  periodStart: Date | null;
  periodEnd: Date | null;
}) {
  const entitlements = getPlanDefinition(input.plan).entitlements;
  const now = new Date();
  let wallet = await prisma.tokenWallet.findUnique({
    where: { userId: input.userId }
  });

  if (!wallet) {
    wallet = await prisma.tokenWallet.create({
      data: {
        userId: input.userId,
        monthlyTokensRemaining: entitlements.monthlyTokenAllowance,
        purchasedTokensRemaining: 0,
        totalTokensUsed: 0,
        monthlyAllowance: entitlements.monthlyTokenAllowance,
        periodStart: input.periodStart ?? now,
        periodEnd: input.periodEnd ?? addMonths(now, 1)
      }
    });

    if (entitlements.monthlyTokenAllowance > 0) {
      await prisma.tokenTransaction.create({
        data: {
          userId: input.userId,
          type: "monthly_reset",
          source: "subscription",
          amount: entitlements.monthlyTokenAllowance,
          description: `Monthly allowance (${input.plan})`,
          metadata: {
            reason: "bootstrap",
            plan: input.plan
          }
        }
      });
    }
  } else if (
    periodExpired({
      now,
      subscriptionPeriodEnd: input.periodEnd,
      walletPeriodEnd: wallet.periodEnd
    })
  ) {
    wallet = await prisma.tokenWallet.update({
      where: { id: wallet.id },
      data: {
        monthlyTokensRemaining: entitlements.monthlyTokenAllowance,
        monthlyAllowance: entitlements.monthlyTokenAllowance,
        periodStart: input.periodStart ?? now,
        periodEnd: input.periodEnd ?? addMonths(now, 1)
      }
    });

    await prisma.tokenTransaction.create({
      data: {
        userId: input.userId,
        type: "monthly_reset",
        source: "subscription",
        amount: entitlements.monthlyTokenAllowance,
        description: `Monthly allowance reset (${input.plan})`,
        metadata: {
          reason: "period_rollover",
          plan: input.plan
        }
      }
    });
  } else if (wallet.monthlyAllowance < entitlements.monthlyTokenAllowance) {
    // Plan-level upgrade inside the same billing period (for example admin override to Pro).
    // Raise the monthly allowance immediately and top up remaining monthly tokens to the new cap once.
    const nextAllowance = entitlements.monthlyTokenAllowance;
    const topUpAmount = Math.max(0, nextAllowance - wallet.monthlyTokensRemaining);

    wallet = await prisma.tokenWallet.update({
      where: { id: wallet.id },
      data: {
        monthlyAllowance: nextAllowance,
        monthlyTokensRemaining: Math.max(wallet.monthlyTokensRemaining, nextAllowance)
      }
    });

    if (topUpAmount > 0) {
      await prisma.tokenTransaction.create({
        data: {
          userId: input.userId,
          type: "credit",
          source: "admin",
          amount: topUpAmount,
          description: `Allowance top-up (${input.plan})`,
          metadata: {
            reason: "plan_upgrade_mid_period",
            plan: input.plan
          }
        }
      });
    }
  }

  return wallet;
}

export async function resolveBillingStateForUser(userId: string): Promise<BillingState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true }
  });
  const subscription = await ensureSubscriptionForUser(userId);
  const effectivePlan = applyAdminPlanOverride({
    plan: effectivePlanFromSubscription({
      plan: subscription.plan,
      status: subscription.status
    }),
    email: user?.email ?? null
  });
  const entitlements = getPlanDefinition(effectivePlan).entitlements;
  const wallet = await ensureWalletForUser({
    userId,
    plan: effectivePlan,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd
  });

  return {
    subscription: {
      id: subscription.id,
      plan: effectivePlan,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
    },
    wallet: {
      id: wallet.id,
      monthlyTokensRemaining: wallet.monthlyTokensRemaining,
      purchasedTokensRemaining: wallet.purchasedTokensRemaining,
      totalTokensUsed: wallet.totalTokensUsed,
      monthlyAllowance: wallet.monthlyAllowance,
      periodStart: wallet.periodStart ?? null,
      periodEnd: wallet.periodEnd ?? null,
      updatedAt: wallet.updatedAt
    },
    entitlements,
    availableTokens: wallet.monthlyTokensRemaining + wallet.purchasedTokensRemaining
  };
}

export async function assertProjectCreationEntitlement(userId: string) {
  const state = await resolveBillingStateForUser(userId);
  if (!state.entitlements.canCreateProject) {
    throw new HttpError(403, "Your plan does not allow creating projects.", "plan_forbidden");
  }

  const ownedProjects = await prisma.project.count({
    where: { ownerId: userId }
  });
  if (ownedProjects >= state.entitlements.maxProjects) {
    throw new HttpError(
      403,
      `Project limit reached for your plan (${state.entitlements.maxProjects}).`,
      "project_limit_reached"
    );
  }

  return state;
}

export async function assertUploadEntitlement(input: {
  userId: string;
  byteSize: number;
}) {
  const state = await resolveBillingStateForUser(input.userId);
  const maxUploadBytes = state.entitlements.maxUploadMb * 1024 * 1024;
  if (input.byteSize > maxUploadBytes) {
    throw new HttpError(
      403,
      `Upload exceeds your plan limit (${state.entitlements.maxUploadMb}MB).`,
      "upload_limit_reached"
    );
  }

  const ownedProjects = await prisma.project.findMany({
    where: { ownerId: input.userId },
    select: { id: true }
  });
  const projectIds = ownedProjects.map((project) => project.id);
  const [artifactSum, uploadSum] = await Promise.all([
    prisma.artifact.aggregate({
      _sum: { byteSize: true },
      where: { projectId: { in: projectIds } }
    }),
    prisma.uploadAsset.aggregate({
      _sum: { byteSize: true },
      where: { projectId: { in: projectIds } }
    })
  ]);
  const usedBytes = (artifactSum._sum.byteSize ?? 0) + (uploadSum._sum.byteSize ?? 0);
  const maxStorageBytes = state.entitlements.maxStorageGb * 1024 * 1024 * 1024;
  if (usedBytes + input.byteSize > maxStorageBytes) {
    throw new HttpError(
      403,
      `Storage quota exceeded for your plan (${state.entitlements.maxStorageGb}GB).`,
      "storage_limit_reached"
    );
  }

  return state;
}

export function allPlanDefinitions() {
  return planOrder.map((plan) => getPlanDefinition(plan));
}
