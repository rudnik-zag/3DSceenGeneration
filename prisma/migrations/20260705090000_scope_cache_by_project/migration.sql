DROP INDEX IF EXISTS "CacheEntry_cacheKey_key";

CREATE UNIQUE INDEX "CacheEntry_projectId_cacheKey_key"
ON "CacheEntry"("projectId", "cacheKey");
