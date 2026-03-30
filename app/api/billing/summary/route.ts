import { NextRequest, NextResponse } from "next/server";

import { resolveBillingStateForUser } from "@/lib/billing/entitlements";
import { allPlanDefinitions } from "@/lib/billing/entitlements";
import { tokenPackDefinitions } from "@/lib/billing/plans";
import { requireAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuthUser();
    await enforceRateLimit({
      bucket: "billing:summary",
      identifier: user.id,
      limit: env.SIGNED_URL_LIMIT,
      windowSec: env.SIGNED_URL_WINDOW_SEC,
      message: "Billing summary rate limit exceeded"
    });

    const [state, transactions, usageEvents] = await Promise.all([
      resolveBillingStateForUser(user.id),
      prisma.tokenTransaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      prisma.usageEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 100
      })
    ]);

    return NextResponse.json({
      state,
      transactions,
      usageEvents,
      plans: allPlanDefinitions(),
      tokenPacks: tokenPackDefinitions
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to load billing summary");
  }
}

