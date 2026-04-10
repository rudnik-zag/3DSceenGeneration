import { createHmac, timingSafeEqual } from "crypto";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function required(key: string) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}

function normalizeMetadata(metadata?: Record<string, string>) {
  if (!metadata) return {};
  const entries = Object.entries(metadata)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return Object.fromEntries(entries);
}

function toFormBody(fields: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

async function stripeApiPostForm<T>(path: string, fields: Record<string, string | number | boolean | null | undefined>) {
  const secret = required("STRIPE_SECRET_KEY");
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: toFormBody(fields),
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && payload.error?.message
        ? payload.error.message
        : `Stripe API request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim().length > 0);
}

export function getStripeWebhookSecret() {
  return required("STRIPE_WEBHOOK_SECRET");
}

export function getAppBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim() || "http://localhost:3000";
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  mode: "payment" | "subscription";
  customer: string | null;
  subscription: string | null;
  payment_status: string;
  metadata: Record<string, string>;
  customer_details?: {
    email?: string | null;
  } | null;
}

export async function createStripeCheckoutSession(input: {
  mode: "payment" | "subscription";
  successUrl: string;
  cancelUrl: string;
  clientReferenceId?: string;
  customerEmail?: string | null;
  metadata?: Record<string, string>;
  subscriptionMetadata?: Record<string, string>;
  lineItems: Array<{ priceId: string; quantity: number }>;
}) {
  const form: Record<string, string | number | boolean | null | undefined> = {
    mode: input.mode,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    client_reference_id: input.clientReferenceId,
    customer_email: input.customerEmail ?? undefined
  };

  const metadata = normalizeMetadata(input.metadata);
  for (const [key, value] of Object.entries(metadata)) {
    form[`metadata[${key}]`] = value;
  }
  if (input.mode === "subscription") {
    const subscriptionMetadata = normalizeMetadata(input.subscriptionMetadata ?? input.metadata);
    for (const [key, value] of Object.entries(subscriptionMetadata)) {
      form[`subscription_data[metadata][${key}]`] = value;
    }
  }

  for (const [index, item] of input.lineItems.entries()) {
    form[`line_items[${index}][price]`] = item.priceId;
    form[`line_items[${index}][quantity]`] = Math.max(1, Math.floor(item.quantity));
  }

  return stripeApiPostForm<StripeCheckoutSession>("/checkout/sessions", form);
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export async function createStripeBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}) {
  return stripeApiPostForm<StripePortalSession>("/billing_portal/sessions", {
    customer: input.customerId,
    return_url: input.returnUrl
  });
}

function timingSafeHexEqual(leftHex: string, rightHex: string) {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyStripeWebhookSignature(input: {
  payload: string;
  signatureHeader: string | null;
  toleranceSec?: number;
}) {
  const header = input.signatureHeader?.trim();
  if (!header) return false;
  const timestampPart = header
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("t="));
  const signatureParts = header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="));
  if (!timestampPart || signatureParts.length === 0) return false;

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return false;
  const tolerance = Math.max(1, Math.floor(input.toleranceSec ?? 300));
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSec > tolerance) return false;

  const signedPayload = `${timestamp}.${input.payload}`;
  const expected = createHmac("sha256", getStripeWebhookSecret()).update(signedPayload, "utf8").digest("hex");
  return signatureParts.some((part) => timingSafeHexEqual(part.slice(3), expected));
}

export interface StripeWebhookEventObject {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

