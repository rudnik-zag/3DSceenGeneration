-- Billing, subscription, token wallet, usage ledger

CREATE TYPE "SubscriptionPlan" AS ENUM ('Free', 'Creator', 'Pro', 'Studio');
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired');
CREATE TYPE "TokenTransactionType" AS ENUM ('credit', 'debit', 'refund', 'monthly_reset');
CREATE TYPE "TokenTransactionSource" AS ENUM ('subscription', 'token_pack', 'usage', 'admin');
CREATE TYPE "UsageEventStatus" AS ENUM ('reserved', 'completed', 'failed', 'canceled');

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "SubscriptionPlan" NOT NULL DEFAULT 'Free',
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
  "billingProvider" TEXT,
  "billingCustomerId" TEXT,
  "billingSubscriptionId" TEXT,
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE UNIQUE INDEX "Subscription_billingSubscriptionId_key" ON "Subscription"("billingSubscriptionId");
CREATE INDEX "Subscription_plan_status_idx" ON "Subscription"("plan", "status");

CREATE TABLE "TokenWallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "monthlyTokensRemaining" INTEGER NOT NULL DEFAULT 0,
  "purchasedTokensRemaining" INTEGER NOT NULL DEFAULT 0,
  "totalTokensUsed" INTEGER NOT NULL DEFAULT 0,
  "monthlyAllowance" INTEGER NOT NULL DEFAULT 0,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TokenWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TokenWallet_userId_key" ON "TokenWallet"("userId");

CREATE TABLE "TokenTransaction" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "runId" TEXT,
  "type" "TokenTransactionType" NOT NULL,
  "source" "TokenTransactionSource" NOT NULL,
  "amount" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TokenTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TokenTransaction_userId_createdAt_idx" ON "TokenTransaction"("userId", "createdAt");
CREATE INDEX "TokenTransaction_projectId_createdAt_idx" ON "TokenTransaction"("projectId", "createdAt");
CREATE INDEX "TokenTransaction_runId_createdAt_idx" ON "TokenTransaction"("runId", "createdAt");
CREATE INDEX "TokenTransaction_type_source_createdAt_idx" ON "TokenTransaction"("type", "source", "createdAt");

CREATE TABLE "UsageEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "featureKey" TEXT NOT NULL,
  "estimatedTokenCost" INTEGER NOT NULL,
  "actualTokenCost" INTEGER,
  "status" "UsageEventStatus" NOT NULL DEFAULT 'reserved',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageEvent_runId_key" ON "UsageEvent"("runId");
CREATE INDEX "UsageEvent_userId_createdAt_idx" ON "UsageEvent"("userId", "createdAt");
CREATE INDEX "UsageEvent_projectId_createdAt_idx" ON "UsageEvent"("projectId", "createdAt");
CREATE INDEX "UsageEvent_status_createdAt_idx" ON "UsageEvent"("status", "createdAt");

CREATE TABLE "StripeWebhookEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "processed" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripeWebhookEvent_eventId_key" ON "StripeWebhookEvent"("eventId");
CREATE INDEX "StripeWebhookEvent_eventType_createdAt_idx" ON "StripeWebhookEvent"("eventType", "createdAt");
CREATE INDEX "StripeWebhookEvent_processed_createdAt_idx" ON "StripeWebhookEvent"("processed", "createdAt");

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TokenWallet"
  ADD CONSTRAINT "TokenWallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TokenTransaction"
  ADD CONSTRAINT "TokenTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TokenTransaction"
  ADD CONSTRAINT "TokenTransaction_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TokenTransaction"
  ADD CONSTRAINT "TokenTransaction_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Bootstrap existing users to Free plan + initial wallet allowance
INSERT INTO "Subscription" (
  "id",
  "userId",
  "plan",
  "status",
  "currentPeriodStart",
  "currentPeriodEnd",
  "createdAt",
  "updatedAt"
)
SELECT
  ('sub_' || md5(random()::text || clock_timestamp()::text || u."id"))::text,
  u."id",
  'Free'::"SubscriptionPlan",
  'active'::"SubscriptionStatus",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '1 month',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User" u
LEFT JOIN "Subscription" s ON s."userId" = u."id"
WHERE s."id" IS NULL;

INSERT INTO "TokenWallet" (
  "id",
  "userId",
  "monthlyTokensRemaining",
  "purchasedTokensRemaining",
  "totalTokensUsed",
  "monthlyAllowance",
  "periodStart",
  "periodEnd",
  "updatedAt"
)
SELECT
  ('wal_' || md5(random()::text || clock_timestamp()::text || u."id"))::text,
  u."id",
  200,
  0,
  0,
  200,
  COALESCE(s."currentPeriodStart", CURRENT_TIMESTAMP),
  COALESCE(s."currentPeriodEnd", CURRENT_TIMESTAMP + INTERVAL '1 month'),
  CURRENT_TIMESTAMP
FROM "User" u
LEFT JOIN "TokenWallet" w ON w."userId" = u."id"
LEFT JOIN "Subscription" s ON s."userId" = u."id"
WHERE w."id" IS NULL;

INSERT INTO "TokenTransaction" (
  "id",
  "userId",
  "type",
  "source",
  "amount",
  "description",
  "metadata",
  "createdAt"
)
SELECT
  ('tx_' || md5(random()::text || clock_timestamp()::text || u."id"))::text,
  u."id",
  'monthly_reset'::"TokenTransactionType",
  'subscription'::"TokenTransactionSource",
  200,
  'Bootstrap monthly allowance',
  '{"reason":"bootstrap"}'::jsonb,
  CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "TokenTransaction" t
  WHERE t."userId" = u."id" AND t."type" = 'monthly_reset'::"TokenTransactionType"
);
