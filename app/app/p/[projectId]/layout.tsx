import { notFound } from "next/navigation";

import { ProjectLayoutShell } from "@/components/layout/project-layout-shell";
import { prisma } from "@/lib/db";

export default async function ProjectLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
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

  if (!project) {
    notFound();
  }

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
