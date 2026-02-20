import { AppShell } from "@/components/layout/app-shell";
import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";

export default async function AppLayout({
  children
}: {
  children: React.ReactNode;
}) {
  const user = await getOrCreateDefaultUser();
  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true
    }
  });

  return <AppShell projects={projects}>{children}</AppShell>;
}
