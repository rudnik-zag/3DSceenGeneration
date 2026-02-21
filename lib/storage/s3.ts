import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
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
  if (bucketReady) {
    return;
  }

  const client = getClient();

  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }

  bucketReady = true;
}

export async function putObjectToStorage(params: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
}) {
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
    console.warn(`[storage] Falling back to local write for key "${params.key}"`, error);
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
  try {
    return await getSignedDownloadUrl(key, expiresIn);
  } catch (error) {
    console.error(`[storage] Failed to sign download URL for key "${key}"`, error);
    if (await localObjectExists(key)) {
      return `/api/storage/object?key=${encodeURIComponent(key)}`;
    }
    return null;
  }
}

export async function storageObjectExists(key: string): Promise<boolean> {
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
  } catch {
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
  try {
    return await getSignedUploadUrl(key, contentType, expiresIn);
  } catch (error) {
    console.error(`[storage] Failed to sign upload URL for key "${key}"`, error);
    return null;
  }
}

export async function getObjectBuffer(key: string) {
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
    console.warn(`[storage] Falling back to local read for key "${key}"`, error);
    return readLocalObject(key);
  }
}

export async function getStorageObjectContentType(key: string): Promise<string | null> {
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
  } catch {
    return readLocalContentType(key);
  }
}
