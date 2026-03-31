import { DashboardClient } from "@/components/layout/dashboard-client";
import { prisma } from "@/lib/db";
import { requirePageAuthUser } from "@/lib/auth/session";
import { ProjectItem } from "@/components/layout/dashboard-client";

export default async function DashboardPage() {
  const user = await requirePageAuthUser();

  const projectsRaw = await prisma.project.findMany({
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
    include: {
      _count: {
        select: {
          graphs: true,
          runs: true
        }
      }
    }
  });

  const latestPreviewByProject = new Map<
    string,
    {
      previewArtifactId: string;
      previewStorageKey: string;
      previewMimeType: string;
      previewUpdatedAt: string;
    }
  >();

  await Promise.all(
    projectsRaw.map(async (project) => {
      const candidates = await prisma.artifact.findMany({
        where: {
          projectId: project.id,
          kind: "image"
        },
        orderBy: { createdAt: "desc" },
        take: 24,
        select: {
          id: true,
          storageKey: true,
          previewStorageKey: true,
          mimeType: true,
          createdAt: true,
          meta: true
        }
      });

      const latestVisible =
        candidates.find((artifact) => {
          if (!artifact.meta || typeof artifact.meta !== "object" || Array.isArray(artifact.meta)) return true;
          return (artifact.meta as Record<string, unknown>).hidden !== true;
        }) ?? null;
      const chosen = latestVisible ?? candidates[0] ?? null;

      if (!chosen) return;
      latestPreviewByProject.set(project.id, {
        previewArtifactId: chosen.id,
        previewStorageKey: chosen.previewStorageKey ?? chosen.storageKey,
        previewMimeType: chosen.mimeType,
        previewUpdatedAt: chosen.createdAt.toISOString()
      });
    })
  );

  const projects: ProjectItem[] = projectsRaw.map((project) => ({
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    previewArtifactId: latestPreviewByProject.get(project.id)?.previewArtifactId ?? null,
    previewStorageKey: latestPreviewByProject.get(project.id)?.previewStorageKey ?? null,
    previewMimeType: latestPreviewByProject.get(project.id)?.previewMimeType ?? null,
    previewUpdatedAt: latestPreviewByProject.get(project.id)?.previewUpdatedAt ?? null
  }));

  return <DashboardClient initialProjects={projects} />;
}
