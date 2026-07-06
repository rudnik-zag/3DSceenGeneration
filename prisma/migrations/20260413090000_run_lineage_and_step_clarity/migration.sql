-- Human-readable run/version metadata and step taxonomy

-- 1) Project-level run counter for stable per-project run numbers.
CREATE TABLE IF NOT EXISTS "ProjectRunCounter" (
  "projectId" TEXT NOT NULL,
  "nextRunNumber" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectRunCounter_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "ProjectRunCounter_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- 2) Add runNumber to runs and backfill existing rows per project.
ALTER TABLE "Run"
  ADD COLUMN IF NOT EXISTS "runNumber" INTEGER;

WITH ranked AS (
  SELECT
    r."id",
    ROW_NUMBER() OVER (
      PARTITION BY r."projectId"
      ORDER BY r."createdAt" ASC, r."id" ASC
    )::INTEGER AS rn
  FROM "Run" r
)
UPDATE "Run" r
SET "runNumber" = ranked.rn
FROM ranked
WHERE r."id" = ranked."id"
  AND r."runNumber" IS NULL;

ALTER TABLE "Run"
  ALTER COLUMN "runNumber" SET NOT NULL;

-- 3) Ensure counter starts after max existing run number.
INSERT INTO "ProjectRunCounter" ("projectId", "nextRunNumber", "createdAt", "updatedAt")
SELECT
  p."id" AS "projectId",
  COALESCE(MAX(r."runNumber"), 0) + 1 AS "nextRunNumber",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Project" p
LEFT JOIN "Run" r
  ON r."projectId" = p."id"
GROUP BY p."id"
ON CONFLICT ("projectId")
DO UPDATE SET
  "nextRunNumber" = EXCLUDED."nextRunNumber",
  "updatedAt" = CURRENT_TIMESTAMP;

-- 4) Step clarity fields.
ALTER TABLE "RunStep"
  ADD COLUMN IF NOT EXISTS "stepCode" TEXT,
  ADD COLUMN IF NOT EXISTS "stepLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 1;

-- Backfill stepCode from existing nodeType values.
UPDATE "RunStep"
SET "stepCode" = UPPER(REPLACE(REPLACE("nodeType", '.', '_'), '-', '_'))
WHERE "stepCode" IS NULL;

-- 5) Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "Run_projectId_runNumber_key" ON "Run"("projectId", "runNumber");
CREATE INDEX IF NOT EXISTS "RunStep_runId_stepCode_sequence_idx" ON "RunStep"("runId", "stepCode", "sequence");

