const requiredServerVars = [
  "DATABASE_URL",
  "AUTH_SECRET",
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

function parseCsvList(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "minioadmin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "minioadmin",
  S3_BUCKET: process.env.S3_BUCKET ?? "artifacts",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === "true",
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  SAM2_REPO_ROOT: process.env.SAM2_REPO_ROOT ?? "",
  SAM2_CHECKPOINT: process.env.SAM2_CHECKPOINT ?? "",
  SAM2_TOOLS_DIR: process.env.SAM2_TOOLS_DIR ?? "",
  SAM2_USE_CONDA: process.env.SAM2_USE_CONDA ?? "true",
  SAM2_CONDA_COMMAND: process.env.SAM2_CONDA_COMMAND ?? "conda",
  SAM2_CONDA_ENV: process.env.SAM2_CONDA_ENV ?? "sam2",
  AUTH_LOGIN_LIMIT: Number(process.env.AUTH_LOGIN_LIMIT ?? 6),
  AUTH_LOGIN_WINDOW_SEC: Number(process.env.AUTH_LOGIN_WINDOW_SEC ?? 60),
  AUTH_REGISTER_LIMIT: Number(process.env.AUTH_REGISTER_LIMIT ?? 4),
  AUTH_REGISTER_WINDOW_SEC: Number(process.env.AUTH_REGISTER_WINDOW_SEC ?? 60),
  RUN_CREATE_LIMIT: Number(process.env.RUN_CREATE_LIMIT ?? 20),
  RUN_CREATE_WINDOW_SEC: Number(process.env.RUN_CREATE_WINDOW_SEC ?? 60),
  UPLOAD_INIT_LIMIT: Number(process.env.UPLOAD_INIT_LIMIT ?? 60),
  UPLOAD_INIT_WINDOW_SEC: Number(process.env.UPLOAD_INIT_WINDOW_SEC ?? 60),
  SIGNED_URL_LIMIT: Number(process.env.SIGNED_URL_LIMIT ?? 120),
  SIGNED_URL_WINDOW_SEC: Number(process.env.SIGNED_URL_WINDOW_SEC ?? 60),
  SIGNED_URL_TTL_SEC: Number(process.env.SIGNED_URL_TTL_SEC ?? 120),
  SIGNED_URL_MAX_TTL_SEC: Number(process.env.SIGNED_URL_MAX_TTL_SEC ?? 300),
  BILLING_ENFORCEMENT_ENABLED: process.env.BILLING_ENFORCEMENT_ENABLED !== "false",
  BILLING_ADMIN_PRO_EMAILS: parseCsvList(process.env.BILLING_ADMIN_PRO_EMAILS),
  BILLING_CHECKOUT_LIMIT: Number(process.env.BILLING_CHECKOUT_LIMIT ?? 20),
  BILLING_CHECKOUT_WINDOW_SEC: Number(process.env.BILLING_CHECKOUT_WINDOW_SEC ?? 60),
  BILLING_WEBHOOK_LIMIT: Number(process.env.BILLING_WEBHOOK_LIMIT ?? 240),
  BILLING_WEBHOOK_WINDOW_SEC: Number(process.env.BILLING_WEBHOOK_WINDOW_SEC ?? 60),
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  STRIPE_PRICE_FREE_MONTHLY: process.env.STRIPE_PRICE_FREE_MONTHLY ?? "",
  STRIPE_PRICE_CREATOR_MONTHLY: process.env.STRIPE_PRICE_CREATOR_MONTHLY ?? "",
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "",
  STRIPE_PRICE_STUDIO_MONTHLY: process.env.STRIPE_PRICE_STUDIO_MONTHLY ?? "",
  STRIPE_PRICE_TOKEN_PACK_STARTER: process.env.STRIPE_PRICE_TOKEN_PACK_STARTER ?? "",
  STRIPE_PRICE_TOKEN_PACK_GROWTH: process.env.STRIPE_PRICE_TOKEN_PACK_GROWTH ?? "",
  STRIPE_PRICE_TOKEN_PACK_SCALE: process.env.STRIPE_PRICE_TOKEN_PACK_SCALE ?? "",
  LOCAL_STORAGE_ROOT: process.env.LOCAL_STORAGE_ROOT ?? ""
};
