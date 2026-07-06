CREATE TABLE "UploadAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "nodeId" TEXT,
    "category" TEXT NOT NULL DEFAULT 'input.image',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UploadAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UploadAsset_storageKey_key" ON "UploadAsset"("storageKey");
CREATE INDEX "UploadAsset_projectId_createdAt_idx" ON "UploadAsset"("projectId", "createdAt");
CREATE INDEX "UploadAsset_projectId_category_idx" ON "UploadAsset"("projectId", "category");

ALTER TABLE "UploadAsset"
ADD CONSTRAINT "UploadAsset_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
