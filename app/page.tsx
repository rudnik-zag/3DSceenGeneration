import { LandingPage } from "@/components/landing/landing-page";
import { getAuthSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export default async function HomePage() {
  const session = await getAuthSession();
  const user = session?.user;
  const userId = user?.id ?? null;

  let userProjects: Array<{
    id: string;
    name: string;
    updatedAt: string;
    runs: number;
    previewStorageKey: string | null;
  }> = [];

  if (userId) {
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: { userId }
            }
          }
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: {
        _count: {
          select: {
            runs: true
          }
        }
      }
    });

    userProjects = await Promise.all(
      projects.map(async (project) => {
        const candidates = await prisma.artifact.findMany({
          where: {
            projectId: project.id,
            kind: "image"
          },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            storageKey: true,
            previewStorageKey: true,
            meta: true
          }
        });

        const visibleArtifact =
          candidates.find((artifact) => {
            if (!artifact.meta || typeof artifact.meta !== "object" || Array.isArray(artifact.meta)) return true;
            return (artifact.meta as Record<string, unknown>).hidden !== true;
          }) ?? null;
        const chosen = visibleArtifact ?? candidates[0] ?? null;

        return {
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt.toISOString(),
          runs: project._count.runs,
          previewStorageKey: chosen ? (chosen.previewStorageKey ?? chosen.storageKey) : null
        };
      })
    );
  }

  return (
    <LandingPage
      isAuthenticated={Boolean(user?.id)}
      userLabel={user?.name ?? user?.email ?? null}
      userProjects={userProjects}
    />
  );
}
