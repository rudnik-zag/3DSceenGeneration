import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
    return false;
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

export async function getObjectBuffer(key: string) {
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
}
