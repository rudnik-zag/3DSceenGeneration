const requiredServerVars = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "S3_REGION"
] as const;

for (const key of requiredServerVars) {
  if (!process.env[key]) {
    console.warn(`[env] Missing environment variable: ${key}`);
  }
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "minioadmin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "minioadmin",
  S3_BUCKET: process.env.S3_BUCKET ?? "artifacts",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === "true",
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
};
