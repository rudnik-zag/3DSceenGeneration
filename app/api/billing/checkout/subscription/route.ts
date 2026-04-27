import { NextRequest, NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/auth/session";
import { getPlanDefinition } from "@/lib/billing/plans";
import { createStripeCheckoutSession, getAppBaseUrl, isStripeConfigured } from "@/lib/billing/stripe";
import { syncSubscriptionFromBilling } from "@/lib/billing/usage";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { HttpError, toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createSubscriptionCheckoutSchema } from "@/lib/validation/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuthUser();
    await enforceRateLimit({
      bucket: "billing:checkout:subscription",
      identifier: user.id,
      limit: env.BILLING_CHECKOUT_LIMIT,
      windowSec: env.BILLING_CHECKOUT_WINDOW_SEC,
      message: "Subscription checkout rate limit exceeded"
    });

    const body = await req.json().catch(() => ({}));
    const parsed = createSubscriptionCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid checkout payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const plan = parsed.data.plan;
    const isMockBilling = env.BILLING_PROVIDER === "mock";
    if (isMockBilling && process.env.NODE_ENV === "production") {
      throw new HttpError(403, "Mock billing provider is disabled in production.", "billing_provider_forbidden");
    }

    if (isMockBilling || plan === "Free") {
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await syncSubscriptionFromBilling({
        userId: user.id,
        plan,
        status: "active",
        billingProvider: isMockBilling ? "mock" : "manual",
        billingCustomerId: null,
        billingSubscriptionId: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        resetMonthlyAllowance: true
      });
      await logAuditEventFromRequest(req, {
        action: "subscription_change",
        resourceType: "subscription",
        resourceId: user.id,
        userId: user.id
      });
      return NextResponse.json({
        url: `/billing?checkout=success&type=subscription&plan=${encodeURIComponent(plan)}`
      });
    }

    if (!isStripeConfigured()) {
      throw new HttpError(503, "Stripe is not configured on the server.", "billing_unavailable");
    }
    const planDef = getPlanDefinition(plan);
    if (!planDef.stripePriceId) {
      throw new HttpError(
        400,
        `Stripe price id is missing for plan ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()}_MONTHLY.`,
        "billing_misconfigured"
      );
    }

    const baseUrl = getAppBaseUrl();
    const session = await createStripeCheckoutSession({
      mode: "subscription",
      successUrl: `${baseUrl}/billing?checkout=success&type=subscription`,
      cancelUrl: `${baseUrl}/billing?checkout=cancel&type=subscription`,
      clientReferenceId: user.id,
      customerEmail: user.email ?? null,
      metadata: {
        userId: user.id,
        plan
      },
      subscriptionMetadata: {
        userId: user.id,
        plan
      },
      lineItems: [{ priceId: planDef.stripePriceId, quantity: 1 }]
    });
    if (!session.url) {
      throw new HttpError(502, "Stripe did not return a checkout URL.", "billing_checkout_failed");
    }

    await logAuditEventFromRequest(req, {
      action: "subscription_checkout_create",
      resourceType: "subscription",
      resourceId: session.id,
      userId: user.id
    });

    return NextResponse.json({
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to create subscription checkout");
  }
}
