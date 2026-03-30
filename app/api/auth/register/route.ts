import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { resolveBillingStateForUser } from "@/lib/billing/entitlements";
import { logAuditEventFromRequest } from "@/lib/security/audit";
import { toApiErrorResponse, HttpError } from "@/lib/security/errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getRequestIp } from "@/lib/security/request";
import { registerPayloadSchema } from "@/lib/validation/schemas";

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  try {
    const ip = getRequestIp(req);
    await enforceRateLimit({
      bucket: "auth:register",
      identifier: ip,
      limit: Number(process.env.AUTH_REGISTER_LIMIT ?? 4),
      windowSec: Number(process.env.AUTH_REGISTER_WINDOW_SEC ?? 60),
      message: "Too many registration attempts"
    });

    const rawBody = await req.json().catch(() => ({}));
    const parsed = registerPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid registration payload", "validation_error", parsed.error.flatten());
    }

    const email = normalizedEmail(parsed.data.email);
    const existing = await prisma.user.findFirst({
      where: { email },
      select: { id: true }
    });
    if (existing) {
      throw new HttpError(409, "Email is already registered", "email_exists");
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: parsed.data.name?.trim() || null
      },
      select: {
        id: true,
        email: true,
        name: true
      }
    });

    try {
      await resolveBillingStateForUser(user.id);
    } catch (error) {
      // Do not block account creation if billing bootstrap fails.
      console.error("[auth/register] billing bootstrap failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await logAuditEventFromRequest(req, {
      action: "register",
      resourceType: "user",
      resourceId: user.id,
      userId: user.id
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (error) {
    console.error("[auth/register] failed", error);
    return toApiErrorResponse(error, "Registration failed");
  }
}
