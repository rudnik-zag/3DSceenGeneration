import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { creditTokenPack, syncSubscriptionFromBilling } from "@/lib/billing/usage";
import { getPlanByStripePriceId, getTokenPackByKey, isSubscriptionPlanKey } from "@/lib/billing/plans";
import { StripeWebhookEventObject, verifyStripeWebhookSignature } from "@/lib/billing/stripe";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logAuditEvent } from "@/lib/security/audit";
import { HttpError, toApiErrorResponse } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getRequestIp } from "@/lib/security/request";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : Boolean(value);
}

function asDateFromUnix(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

type SubscriptionStatusLike =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired";

function stripeStatusToSubscriptionStatus(value: unknown): SubscriptionStatusLike {
  const raw = asString(value);
  switch (raw) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
      return "canceled";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "incomplete_expired";
    default:
      return "active";
  }
}

async function resolveUserIdForStripeEvent(input: {
  metadata?: Record<string, unknown>;
  customerId?: string | null;
  subscriptionId?: string | null;
  email?: string | null;
}) {
  const metadataUserId = asString(input.metadata?.userId);
  if (metadataUserId) {
    const user = await prisma.user.findUnique({
      where: { id: metadataUserId },
      select: { id: true }
    });
    if (user) return user.id;
  }

  const subscriptionId = asString(input.subscriptionId);
  if (subscriptionId) {
    const bySubscription = await prisma.subscription.findFirst({
      where: { billingSubscriptionId: subscriptionId },
      select: { userId: true }
    });
    if (bySubscription?.userId) return bySubscription.userId;
  }

  const customerId = asString(input.customerId);
  if (customerId) {
    const byCustomer = await prisma.subscription.findFirst({
      where: { billingCustomerId: customerId },
      select: { userId: true }
    });
    if (byCustomer?.userId) return byCustomer.userId;
  }

  const email = asString(input.email)?.toLowerCase();
  if (email) {
    const byEmail = await prisma.user.findFirst({
      where: { email },
      select: { id: true }
    });
    if (byEmail?.id) return byEmail.id;
  }

  return null;
}

function resolvePlanFromPriceId(priceId: string | null) {
  if (!priceId) return null;
  return getPlanByStripePriceId(priceId);
}

function findFirstPriceIdInLineCollection(linesValue: unknown) {
  const lines = asRecord(linesValue);
  const data = Array.isArray(lines.data) ? lines.data : [];
  for (const entry of data) {
    const line = asRecord(entry);
    const price = asRecord(line.price);
    const priceId = asString(price.id);
    if (priceId) return priceId;
  }
  return null;
}

async function handleCheckoutSessionCompleted(event: StripeWebhookEventObject) {
  const session = asRecord(event.data.object);
  const mode = asString(session.mode);
  const metadata = asRecord(session.metadata);
  const customerDetails = asRecord(session.customer_details);
  const userId = await resolveUserIdForStripeEvent({
    metadata,
    customerId: asString(session.customer),
    subscriptionId: asString(session.subscription),
    email: asString(customerDetails.email)
  });
  if (!userId) return;

  if (mode === "subscription") {
    const metadataPlan = asString(metadata.plan);
    const plan = metadataPlan && isSubscriptionPlanKey(metadataPlan) ? metadataPlan : "Free";
    await syncSubscriptionFromBilling({
      userId,
      plan,
      status: "active",
      billingProvider: "stripe",
      billingCustomerId: asString(session.customer),
      billingSubscriptionId: asString(session.subscription),
      resetMonthlyAllowance: true
    });
    await logAuditEvent({
      action: "subscription_change",
      resourceType: "subscription",
      resourceId: asString(session.subscription),
      userId
    });
    return;
  }

  if (mode === "payment" && asString(session.payment_status) === "paid") {
    const packKey = asString(metadata.packKey);
    const pack = packKey ? getTokenPackByKey(packKey) : null;
    if (!pack) return;
    await creditTokenPack({
      userId,
      tokenAmount: pack.tokens,
      description: `Token pack purchase (${pack.title})`,
      metadata: {
        stripeEventId: event.id,
        stripeSessionId: asString(session.id),
        packKey: pack.key
      }
    });
    await logAuditEvent({
      action: "token_pack_purchase",
      resourceType: "token_pack",
      resourceId: asString(session.id),
      userId
    });
  }
}

async function handleSubscriptionUpdated(event: StripeWebhookEventObject) {
  const subscription = asRecord(event.data.object);
  const metadata = asRecord(subscription.metadata);
  const items = asRecord(subscription.items);
  const itemData = Array.isArray(items.data) ? items.data : [];
  const firstItem = asRecord(itemData[0]);
  const firstPriceId = asString(asRecord(firstItem.price).id);
  const metadataPlan = asString(metadata.plan);
  const resolvedPlan =
    resolvePlanFromPriceId(firstPriceId) ?? (metadataPlan && isSubscriptionPlanKey(metadataPlan) ? metadataPlan : "Free");
  const userId = await resolveUserIdForStripeEvent({
    metadata,
    customerId: asString(subscription.customer),
    subscriptionId: asString(subscription.id),
    email: null
  });
  if (!userId) return;

  const status =
    event.type === "customer.subscription.deleted"
      ? ("canceled" as const)
      : stripeStatusToSubscriptionStatus(subscription.status);

  await syncSubscriptionFromBilling({
    userId,
    plan: resolvedPlan,
    status,
    billingProvider: "stripe",
    billingCustomerId: asString(subscription.customer),
    billingSubscriptionId: asString(subscription.id),
    currentPeriodStart: asDateFromUnix(subscription.current_period_start),
    currentPeriodEnd: asDateFromUnix(subscription.current_period_end),
    cancelAtPeriodEnd: asBoolean(subscription.cancel_at_period_end)
  });
  await logAuditEvent({
    action: "subscription_change",
    resourceType: "subscription",
    resourceId: asString(subscription.id),
    userId
  });
}

async function handleInvoicePaid(event: StripeWebhookEventObject) {
  const invoice = asRecord(event.data.object);
  const customerId = asString(invoice.customer);
  const subscriptionId = asString(invoice.subscription);
  const metadata = asRecord(invoice.metadata);
  const userId = await resolveUserIdForStripeEvent({
    metadata,
    customerId,
    subscriptionId,
    email: null
  });
  if (!userId) return;

  const firstPriceId = findFirstPriceIdInLineCollection(invoice.lines);
  const existing = await prisma.subscription.findUnique({
    where: { userId },
    select: { plan: true }
  });
  const planFromPrice = resolvePlanFromPriceId(firstPriceId);
  const resolvedPlan = planFromPrice ?? (existing?.plan ?? "Free");

  await syncSubscriptionFromBilling({
    userId,
    plan: resolvedPlan,
    status: "active",
    billingProvider: "stripe",
    billingCustomerId: customerId,
    billingSubscriptionId: subscriptionId,
    currentPeriodStart: asDateFromUnix(invoice.period_start),
    currentPeriodEnd: asDateFromUnix(invoice.period_end),
    resetMonthlyAllowance: true
  });
  await logAuditEvent({
    action: "subscription_change",
    resourceType: "subscription",
    resourceId: subscriptionId,
    userId
  });
}

async function processStripeEvent(event: StripeWebhookEventObject) {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(event);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionUpdated(event);
      return;
    case "invoice.paid":
      await handleInvoicePaid(event);
      return;
    default:
      return;
  }
}

export async function POST(req: NextRequest) {
  let eventId: string | null = null;

  try {
    await enforceRateLimit({
      bucket: "billing:webhook",
      identifier: getRequestIp(req),
      limit: env.BILLING_WEBHOOK_LIMIT,
      windowSec: env.BILLING_WEBHOOK_WINDOW_SEC,
      message: "Webhook rate limit exceeded"
    });

    const payload = await req.text();
    const signature = req.headers.get("stripe-signature");
    const isValid = verifyStripeWebhookSignature({
      payload,
      signatureHeader: signature,
      toleranceSec: 300
    });
    if (!isValid) {
      throw new HttpError(400, "Invalid Stripe webhook signature.", "invalid_signature");
    }

    const parsed = JSON.parse(payload) as StripeWebhookEventObject;
    if (!parsed?.id || !parsed?.type) {
      throw new HttpError(400, "Invalid Stripe event payload.", "invalid_payload");
    }
    eventId = parsed.id;

    const existing = await prisma.stripeWebhookEvent.findUnique({
      where: { eventId }
    });
    if (existing?.processed) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (!existing) {
      try {
        await prisma.stripeWebhookEvent.create({
          data: {
            eventId,
            eventType: parsed.type,
            processed: false,
            payload: parsed as unknown as Prisma.InputJsonValue
          }
        });
      } catch {
        const concurrent = await prisma.stripeWebhookEvent.findUnique({
          where: { eventId }
        });
        if (concurrent?.processed) {
          return NextResponse.json({ received: true, duplicate: true });
        }
      }
    }

    await processStripeEvent(parsed);

    await prisma.stripeWebhookEvent.update({
      where: { eventId },
      data: {
        processed: true,
        eventType: parsed.type,
        payload: parsed as unknown as Prisma.InputJsonValue
      }
    });

    return NextResponse.json({ received: true });
  } catch (error) {
    if (eventId) {
      await prisma.stripeWebhookEvent
        .update({
          where: { eventId },
          data: {
            processed: false,
            payload: {
              eventId,
              error: error instanceof Error ? error.message : String(error),
              failedAt: new Date().toISOString()
            } as Prisma.InputJsonValue
          }
        })
        .catch(() => undefined);
    }
    return toApiErrorResponse(error, "Failed to process billing webhook");
  }
}
