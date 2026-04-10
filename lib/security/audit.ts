import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getRequestIp, getRequestUserAgent } from "@/lib/security/request";

interface LogAuditEventInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function logAuditEvent(input: LogAuditEventInput) {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null,
        userId: input.userId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null
      }
    });
  } catch (error) {
    console.warn("[audit] failed to write event", {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      projectId: input.projectId ?? null,
      userId: input.userId ?? null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function logAuditEventFromRequest(
  req: NextRequest,
  input: Omit<LogAuditEventInput, "ipAddress" | "userAgent">
) {
  await logAuditEvent({
    ...input,
    ipAddress: getRequestIp(req),
    userAgent: getRequestUserAgent(req)
  });
}

