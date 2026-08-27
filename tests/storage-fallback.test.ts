import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const localStorageRoot = path.join(os.tmpdir(), "tribalai-storage-fallback-test");
test("storage falls back to local writes on EPERM transport failures", async () => {
  await fs.rm(localStorageRoot, { recursive: true, force: true });
  process.env.LOCAL_STORAGE_ROOT = localStorageRoot;
  process.env.S3_ENDPOINT = "http://127.0.0.1:9";
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_BUCKET = "artifacts";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_FORCE_PATH_STYLE = "true";

  const { getObjectBuffer, putObjectToStorage } = await import("@/lib/storage/s3");

  (globalThis as any).s3ClientSingleton = {
    send: async () => {
      const error = new Error("connect EPERM 127.0.0.1:9 - Local (undefined:undefined)") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    }
  };

  try {
    await putObjectToStorage({
      key: "projects/test/fallback/example.txt",
      body: "fallback-ok",
      contentType: "text/plain"
    });

    const stored = await fs.readFile(path.join(localStorageRoot, "projects/test/fallback/example.txt"), "utf8");
    const meta = await fs.readFile(path.join(localStorageRoot, "projects/test/fallback/example.txt.meta.json"), "utf8");
    const roundTrip = await getObjectBuffer("projects/test/fallback/example.txt");

    assert.equal(stored, "fallback-ok");
    assert.equal(roundTrip.toString("utf8"), "fallback-ok");
    assert.match(meta, /text\/plain/);
  } finally {
    delete (globalThis as any).s3ClientSingleton;
    await fs.rm(localStorageRoot, { recursive: true, force: true });
  }
});
