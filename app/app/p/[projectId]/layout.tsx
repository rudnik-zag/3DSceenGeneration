import { ProjectLayoutShell } from "@/components/layout/project-layout-shell";
import { requirePageProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";

export default async function ProjectLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const access = await requirePageProjectAccess(projectId, "viewer");
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: access.project.id },
    include: {
      _count: {
        select: {
          graphs: true,
          runs: true,
          artifacts: true
        }
      }
    }
  });

  const nav = [
    { href: `/app/p/${projectId}/canvas`, label: "Canvas" },
    { href: `/app/p/${projectId}/runs`, label: "Runs" },
    { href: `/app/p/${projectId}/viewer`, label: "Viewer" }
  ];

  return (
    <ProjectLayoutShell
      projectName={project.name}
      counts={{
        graphs: project._count.graphs,
        runs: project._count.runs,
        artifacts: project._count.artifacts
      }}
      nav={nav}
    >
      {children}
    </ProjectLayoutShell>
  );
}
