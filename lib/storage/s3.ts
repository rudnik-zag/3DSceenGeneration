import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { promises as fs } from "fs";
import path from "path";

import { env } from "@/lib/env";

declare global {
  // eslint-disable-next-line no-var
  var s3ClientSingleton: S3Client | undefined;
}

function getClient() {
  const client =
    global.s3ClientSingleton ??
    new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY
      }
    });

  if (process.env.NODE_ENV !== "production") {
    global.s3ClientSingleton = client;
  }

  return client;
}

let bucketReady = false;
const LOCAL_STORAGE_ROOT = path.join(process.cwd(), ".local-storage");
const S3_DISABLE_TTL_MS = 120_000;
const FALLBACK_LOG_THROTTLE_MS = 30_000;

let s3DisabledUntil = 0;
const fallbackLogLastAt = new Map<string, number>();

type StorageErrorLike = {
  code?: string;
  reason?: string;
  message?: string;
};

function nowMs() {
  return Date.now();
}

function isS3TemporarilyDisabled() {
  return nowMs() < s3DisabledUntil;
}

function shouldTemporarilyDisableS3(error: unknown) {
  const err = error as StorageErrorLike | undefined;
  const code = String(err?.code ?? "");
  const reason = String(err?.reason ?? "");
  const message = String(err?.message ?? "");

  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  ) {
    return true;
  }

  if (code === "HPE_INVALID_CONSTANT") {
    return true;
  }

  if (reason.includes("Expected HTTP/")) {
    return true;
  }

  if (message.includes("Expected HTTP/")) {
    return true;
  }

  return false;
}

function describeStorageError(error: unknown) {
  const err = error as StorageErrorLike | undefined;
  const code = String(err?.code ?? "").trim();
  const reason = String(err?.reason ?? "").trim();
  const message = String(err?.message ?? "").trim();
  const parts = [code && `code=${code}`, reason && `reason=${reason}`, message && `message=${message}`].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function throttledLog(scope: string, level: "warn" | "error", message: string) {
  const lastAt = fallbackLogLastAt.get(scope) ?? 0;
  const now = nowMs();
  if (now - lastAt < FALLBACK_LOG_THROTTLE_MS) {
    return;
  }
  fallbackLogLastAt.set(scope, now);
  if (level === "warn") {
    console.warn(message);
  } else {
    console.error(message);
  }
}

function markS3TemporarilyUnavailable(error: unknown, operation: string) {
  if (!shouldTemporarilyDisableS3(error)) {
    return;
  }

  const wasDisabled = isS3TemporarilyDisabled();
  s3DisabledUntil = nowMs() + S3_DISABLE_TTL_MS;
  bucketReady = false;
  if (!wasDisabled) {
    throttledLog(
      "s3-disable",
      "warn",
      `[storage] S3 endpoint "${env.S3_ENDPOINT}" unavailable (${operation}); using local fallback for ${Math.round(
        S3_DISABLE_TTL_MS / 1000
      )}s${describeStorageError(error)}`
    );
  }
}

function toSafeStoragePath(key: string) {
  const normalized = key.replace(/^\/+/, "").replace(/\.\./g, "_");
  const filePath = path.join(LOCAL_STORAGE_ROOT, normalized);
  return {
    filePath,
    metaPath: `${filePath}.meta.json`
  };
}

function normalizeBody(body: Buffer | Uint8Array | string) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.from(body);
}

async function writeLocalObject(params: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
}) {
  const { filePath, metaPath } = toSafeStoragePath(params.key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, normalizeBody(params.body));
  await fs.writeFile(metaPath, JSON.stringify({ contentType: params.contentType }, null, 2), "utf8");
}

async function readLocalObject(key: string) {
  const { filePath } = toSafeStoragePath(key);
  return fs.readFile(filePath);
}

async function localObjectExists(key: string) {
  try {
    const { filePath } = toSafeStoragePath(key);
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLocalContentType(key: string) {
  try {
    const { metaPath } = toSafeStoragePath(key);
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as { contentType?: string };
    return typeof parsed.contentType === "string" ? parsed.contentType : null;
  } catch {
    return null;
  }
}

export async function ensureBucket() {
  if (isS3TemporarilyDisabled()) {
    throw new Error("S3 temporarily disabled");
  }

  if (bucketReady) {
    return;
  }

  const client = getClient();

  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch (error) {
      markS3TemporarilyUnavailable(error, "ensureBucket");
      throw error;
    }
  }

  bucketReady = true;
}

export async function putObjectToStorage(params: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
}) {
  if (isS3TemporarilyDisabled()) {
    await writeLocalObject(params);
    return;
  }

  try {
    await ensureBucket();

    const client = getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType
      })
    );
  } catch (error) {
    markS3TemporarilyUnavailable(error, "putObject");
    throttledLog("fallback-write", "warn", `[storage] Falling back to local write for key "${params.key}"${describeStorageError(error)}`);
    await writeLocalObject(params);
  }
}

export async function getSignedDownloadUrl(key: string, expiresIn = 60 * 60) {
  await ensureBucket();
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key
    }),
    { expiresIn }
  );
}

export async function safeGetSignedDownloadUrl(
  key: string,
  expiresIn = 60 * 60
): Promise<string | null> {
  if (isS3TemporarilyDisabled()) {
    if (await localObjectExists(key)) {
      return `/api/storage/object?key=${encodeURIComponent(key)}`;
    }
    return null;
  }

  try {
    return await getSignedDownloadUrl(key, expiresIn);
  } catch (error) {
    markS3TemporarilyUnavailable(error, "signDownload");
    throttledLog(
      "fallback-sign-download",
      "warn",
      `[storage] S3 sign download failed; serving local fallback when available${describeStorageError(error)}`
    );
    if (await localObjectExists(key)) {
      return `/api/storage/object?key=${encodeURIComponent(key)}`;
    }
    return null;
  }
}

export async function storageObjectExists(key: string): Promise<boolean> {
  if (isS3TemporarilyDisabled()) {
    return localObjectExists(key);
  }

  try {
    await ensureBucket();
    const client = getClient();
    await client.send(
      new HeadObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );
    return true;
  } catch (error) {
    markS3TemporarilyUnavailable(error, "headObject");
    return localObjectExists(key);
  }
}

export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 60 * 15
) {
  await ensureBucket();
  const client = getClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType
    }),
    { expiresIn }
  );
}

export async function safeGetSignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 60 * 15
): Promise<string | null> {
  if (isS3TemporarilyDisabled()) {
    return null;
  }

  try {
    return await getSignedUploadUrl(key, contentType, expiresIn);
  } catch (error) {
    markS3TemporarilyUnavailable(error, "signUpload");
    throttledLog("fallback-sign-upload", "warn", `[storage] S3 sign upload failed; using direct local upload${describeStorageError(error)}`);
    return null;
  }
}

export async function getObjectBuffer(key: string) {
  if (isS3TemporarilyDisabled()) {
    return readLocalObject(key);
  }

  try {
    await ensureBucket();
    const client = getClient();

    const output = await client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );

    if (!output.Body) {
      throw new Error(`Storage key ${key} has no body`);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of output.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    markS3TemporarilyUnavailable(error, "getObject");
    throttledLog("fallback-read", "warn", `[storage] Falling back to local read for key "${key}"${describeStorageError(error)}`);
    return readLocalObject(key);
  }
}

export async function getStorageObjectContentType(key: string): Promise<string | null> {
  if (isS3TemporarilyDisabled()) {
    return readLocalContentType(key);
  }

  try {
    await ensureBucket();
    const client = getClient();
    const output = await client.send(
      new HeadObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );
    return output.ContentType ?? null;
  } catch (error) {
    markS3TemporarilyUnavailable(error, "headObjectContentType");
    return readLocalContentType(key);
  }
}

function normalizeStoragePrefix(prefix: string) {
  return prefix.replace(/^\/+/, "").replace(/\.\./g, "_");
}

async function deleteLocalPrefix(prefix: string) {
  const normalized = normalizeStoragePrefix(prefix);
  if (!normalized) return;
  const dirPath = path.join(LOCAL_STORAGE_ROOT, normalized);
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function deleteS3Prefix(prefix: string) {
  await ensureBucket();
  const client = getClient();
  let continuationToken: string | undefined;
  const normalized = normalizeStoragePrefix(prefix);

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: normalized,
        ContinuationToken: continuationToken
      })
    );

    const objects =
      listed.Contents?.map((item) => item.Key).filter((key): key is string => Boolean(key)) ?? [];

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: {
            Quiet: true,
            Objects: objects.map((key) => ({ Key: key }))
          }
        })
      );
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

export async function deleteStoragePrefix(prefix: string) {
  const normalized = normalizeStoragePrefix(prefix);
  if (!normalized) return;

  try {
    await deleteLocalPrefix(normalized);
  } catch (error) {
    throttledLog("delete-local-prefix", "warn", `[storage] Failed to delete local storage prefix "${normalized}"${describeStorageError(error)}`);
  }

  if (isS3TemporarilyDisabled()) {
    return;
  }

  try {
    await deleteS3Prefix(normalized);
  } catch (error) {
    markS3TemporarilyUnavailable(error, "deletePrefix");
    throttledLog("delete-s3-prefix", "warn", `[storage] Failed to delete S3 prefix "${normalized}"${describeStorageError(error)}`);
  }
}
