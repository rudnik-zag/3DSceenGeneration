import { NextRequest, NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/auth/session";
import { createStripeBillingPortalSession, getAppBaseUrl, isStripeConfigured } from "@/lib/billing/stripe";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { HttpError, toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuthUser();
    await enforceRateLimit({
      bucket: "billing:portal",
      identifier: user.id,
      limit: env.BILLING_CHECKOUT_LIMIT,
      windowSec: env.BILLING_CHECKOUT_WINDOW_SEC,
      message: "Billing portal rate limit exceeded"
    });
    if (!isStripeConfigured()) {
      throw new HttpError(503, "Stripe is not configured on the server.", "billing_unavailable");
    }

    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: {
        billingCustomerId: true
      }
    });
    const customerId = subscription?.billingCustomerId?.trim();
    if (!customerId) {
      throw new HttpError(400, "No Stripe customer is linked to this account yet.", "billing_portal_unavailable");
    }

    const session = await createStripeBillingPortalSession({
      customerId,
      returnUrl: `${getAppBaseUrl()}/billing`
    });

    return NextResponse.json({
      url: session.url
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to open billing portal");
  }
}

