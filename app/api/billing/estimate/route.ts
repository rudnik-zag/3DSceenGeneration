import { NextRequest, NextResponse } from "next/server";

import { requireProjectAccess } from "@/lib/auth/access";
import { estimateRunForUser } from "@/lib/billing/usage";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { billingEstimatePayloadSchema } from "@/lib/validation/schemas";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = billingEstimatePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid estimate payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { projectId, graphId, startNodeId } = parsed.data;
    const access = await requireProjectAccess(projectId, "editor");
    await enforceRateLimit({
      bucket: "billing:estimate",
      identifier: access.user.id,
      limit: env.RUN_CREATE_LIMIT * 2,
      windowSec: env.RUN_CREATE_WINDOW_SEC,
      message: "Run estimate rate limit exceeded"
    });

    const graph = await prisma.graph.findFirst({
      where: {
        id: graphId,
        projectId
      },
      select: {
        id: true,
        graphJson: true
      }
    });
    if (!graph) {
      return NextResponse.json({ error: "graph_not_found", message: "Graph not found for this project." }, { status: 404 });
    }

    const estimation = await estimateRunForUser({
      userId: access.user.id,
      graphJson: graph.graphJson,
      startNodeId
    });

    return NextResponse.json({
      estimate: estimation.estimate,
      canAfford: env.BILLING_ENFORCEMENT_ENABLED ? estimation.canAfford : true,
      enforcementEnabled: env.BILLING_ENFORCEMENT_ENABLED,
      availableTokens:
        estimation.state.wallet.monthlyTokensRemaining + estimation.state.wallet.purchasedTokensRemaining,
      plan: estimation.state.subscription.plan,
      entitlements: estimation.state.entitlements
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to estimate run tokens");
  }
}

