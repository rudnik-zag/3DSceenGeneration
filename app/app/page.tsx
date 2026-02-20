import { DashboardClient } from "@/components/layout/dashboard-client";
import { prisma } from "@/lib/db";
import { getOrCreateDefaultUser } from "@/lib/default-user";
import { ProjectItem } from "@/components/layout/dashboard-client";

export default async function DashboardPage() {
  const user = await getOrCreateDefaultUser();

  const projectsRaw = await prisma.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: {
        select: {
          graphs: true,
          runs: true
        }
      }
    }
  });

  const projects: ProjectItem[] = projectsRaw.map((project) => ({
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  }));

  return <DashboardClient initialProjects={projects} />;
}
