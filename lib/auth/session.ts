import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth/options";
import { HttpError } from "@/lib/security/errors";

export async function getAuthSession() {
  return getServerSession(authOptions);
}

export async function requireAuthUser() {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    throw new HttpError(401, "Authentication required", "unauthenticated");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true
    }
  });
  if (!user) {
    throw new HttpError(401, "Authentication required", "unauthenticated");
  }

  return user;
}

export async function requirePageAuthUser() {
  try {
    return await requireAuthUser();
  } catch {
    redirect("/login");
  }
}

