import { prisma } from "@/lib/db";

export async function getOrCreateDefaultUser() {
  const first = await prisma.user.findFirst();
  if (first) {
    return first;
  }

  return prisma.user.create({ data: { email: "local@dev.user" } });
}
