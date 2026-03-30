import { PrismaAdapter } from "@auth/prisma-adapter";
import { User } from "@prisma/client";
import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";

import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logAuditEvent } from "@/lib/security/audit";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { loginPayloadSchema } from "@/lib/validation/schemas";

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

const authSecret =
  process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "local-dev-auth-secret";
if (process.env.NODE_ENV === "production" && authSecret === "local-dev-auth-secret") {
  throw new Error("Missing AUTH_SECRET (or NEXTAUTH_SECRET) in production environment.");
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  secret: authSecret,
  debug: process.env.NODE_ENV !== "production",
  useSecureCookies: process.env.NODE_ENV === "production",
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24
  },
  pages: {
    signIn: "/login"
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials, req) {
        const parsed = loginPayloadSchema.safeParse({
          email: credentials?.email,
          password: credentials?.password
        });
        if (!parsed.success) {
          return null;
        }

        const email = normalizedEmail(parsed.data.email);
        const ip = req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ?? "unknown";
        await enforceRateLimit({
          bucket: "auth:login",
          identifier: `${email}:${ip}`,
          limit: Number(process.env.AUTH_LOGIN_LIMIT ?? 6),
          windowSec: Number(process.env.AUTH_LOGIN_WINDOW_SEC ?? 60),
          message: "Too many login attempts"
        });

        const user = await prisma.user.findFirst({
          where: { email }
        });
        if (!user?.passwordHash) {
          await logAuditEvent({
            action: "login_failure",
            resourceType: "user",
            resourceId: user?.id ?? null,
            userId: user?.id ?? null,
            ipAddress: ip,
            userAgent: req.headers?.["user-agent"] ?? "unknown"
          });
          return null;
        }

        const ok = await verifyPassword(user.passwordHash, parsed.data.password);
        if (!ok) {
          await logAuditEvent({
            action: "login_failure",
            resourceType: "user",
            resourceId: user.id,
            userId: user.id,
            ipAddress: ip,
            userAgent: req.headers?.["user-agent"] ?? "unknown"
          });
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image
        } as User;
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const userId = (typeof token.id === "string" ? token.id : null) ?? token.sub ?? null;
        if (userId) {
          session.user.id = userId;
        }
      }
      return session;
    }
  },
  events: {
    async signIn(message) {
      await logAuditEvent({
        action: "login_success",
        resourceType: "user",
        resourceId: message.user.id,
        userId: message.user.id
      });
    },
    async signOut(message) {
      const sessionUserId =
        "session" in message && message.session && "userId" in message.session
          ? (message.session.userId as string)
          : null;
      const tokenUserId =
        "token" in message && message.token
          ? ((typeof message.token.id === "string" ? message.token.id : null) ??
            (typeof message.token.sub === "string" ? message.token.sub : null))
          : null;
      await logAuditEvent({
        action: "logout",
        resourceType: "session",
        userId: sessionUserId ?? tokenUserId
      });
    }
  }
};

export async function ensurePasswordHashForUser(userId: string, rawPassword: string) {
  const passwordHash = await hashPassword(rawPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash }
  });
}
