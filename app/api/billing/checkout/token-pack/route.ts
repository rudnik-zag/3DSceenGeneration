import { NextRequest, NextResponse } from "next/server";

import { requireAuthUser } from "@/lib/auth/session";
import { getTokenPackByKey } from "@/lib/billing/plans";
import { createStripeCheckoutSession, getAppBaseUrl, isStripeConfigured } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { HttpError, toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createTokenPackCheckoutSchema } from "@/lib/validation/schemas";

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuthUser();
    await enforceRateLimit({
      bucket: "billing:checkout:token_pack",
      identifier: user.id,
      limit: env.BILLING_CHECKOUT_LIMIT,
      windowSec: env.BILLING_CHECKOUT_WINDOW_SEC,
      message: "Token-pack checkout rate limit exceeded"
    });

    const body = await req.json().catch(() => ({}));
    const parsed = createTokenPackCheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "validation_error", message: "Invalid checkout payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const pack = getTokenPackByKey(parsed.data.packKey);
    if (!pack) {
      throw new HttpError(404, "Token pack not found.", "token_pack_not_found");
    }
    if (!pack.stripePriceId) {
      throw new HttpError(
        400,
        `Stripe price id is missing for token pack ${pack.key}.`,
        "billing_misconfigured"
      );
    }
    if (!isStripeConfigured()) {
      throw new HttpError(503, "Stripe is not configured on the server.", "billing_unavailable");
    }

    const baseUrl = getAppBaseUrl();
    const session = await createStripeCheckoutSession({
      mode: "payment",
      successUrl: `${baseUrl}/billing?checkout=success&type=token_pack`,
      cancelUrl: `${baseUrl}/billing?checkout=cancel&type=token_pack`,
      clientReferenceId: user.id,
      customerEmail: user.email ?? null,
      metadata: {
        userId: user.id,
        packKey: pack.key,
        tokenAmount: String(pack.tokens)
      },
      lineItems: [{ priceId: pack.stripePriceId, quantity: 1 }]
    });
    if (!session.url) {
      throw new HttpError(502, "Stripe did not return a checkout URL.", "billing_checkout_failed");
    }

    await logAuditEventFromRequest(req, {
      action: "token_pack_checkout_create",
      resourceType: "token_pack",
      resourceId: session.id,
      userId: user.id
    });

    return NextResponse.json({
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    return toApiErrorResponse(error, "Failed to create token pack checkout");
  }
}

