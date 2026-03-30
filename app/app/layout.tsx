import { AppShell } from "@/components/layout/app-shell";
import { prisma } from "@/lib/db";
import { requirePageAuthUser } from "@/lib/auth/session";

export default async function AppLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageAuthUser();
  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { ownerId: user.id },
        {
          members: {
            some: { userId: user.id }
          }
        }
      ]
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true
    }
  });

  return <AppShell projects={projects} currentUserLabel={user.email ?? user.name ?? user.id}>{children}</AppShell>;
}
