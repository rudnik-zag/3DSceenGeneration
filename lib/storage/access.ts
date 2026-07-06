import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/security/errors";

function meshStorageKeyFilter(storageKey: string) {
  return {
    path: ["meshObjectStorageKeys"],
    array_contains: [storageKey]
  } as Record<string, unknown>;
}

export async function storageKeyBelongsToProject(projectId: string, storageKey: string) {
  const key = storageKey.trim();
  if (!key) return false;

  const [artifact, upload] = await Promise.all([
    prisma.artifact.findFirst({
      where: {
        projectId,
        OR: [
          { storageKey: key },
          { previewStorageKey: key },
          { meta: meshStorageKeyFilter(key) as never }
        ]
      },
      select: { id: true }
    }),
    prisma.uploadAsset.findFirst({
      where: { projectId, storageKey: key },
      select: { id: true }
    })
  ]);

  return Boolean(artifact || upload);
}

export async function assertProjectStorageKeyAccess(projectId: string, storageKey: string) {
  if (!(await storageKeyBelongsToProject(projectId, storageKey))) {
    throw new HttpError(403, "Storage object does not belong to this project", "forbidden_storage_key");
  }
  return storageKey.trim();
}
