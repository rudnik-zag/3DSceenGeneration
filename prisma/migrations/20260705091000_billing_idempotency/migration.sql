ALTER TABLE "TokenTransaction"
ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "TokenTransaction_idempotencyKey_key"
ON "TokenTransaction"("idempotencyKey");

ALTER TABLE "StripeWebhookEvent"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastError" TEXT;

UPDATE "StripeWebhookEvent"
SET "status" = CASE WHEN "processed" THEN 'processed' ELSE 'pending' END;
