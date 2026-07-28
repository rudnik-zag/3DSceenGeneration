import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/security/errors";

function meshStorageKeyFilter(storageKey: string) {
  return {
    path: ["meshObjectStorageKeys"],
    array_contains: [storageKey]
  } as Record<string, unknown>;
}

function sequenceFrameStorageKeyFilter(storageKey: string) {
  return {
    path: ["sequenceFrameStorageKeys"],
    array_contains: [storageKey]
  } as Record<string, unknown>;
}

function parseProjectScopeFromStorageKey(storageKey: string) {
  const [root, scope] = storageKey.trim().split("/", 3);
  if (root !== "projects" || !scope) return null;
  return scope;
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
          { meta: meshStorageKeyFilter(key) as never },
          { meta: sequenceFrameStorageKeyFilter(key) as never }
        ]
      },
      select: { id: true }
    }),
    prisma.uploadAsset.findFirst({
      where: { projectId, storageKey: key },
      select: { id: true }
    })
  ]);

  if (artifact || upload) {
    return true;
  }

  const projectScope = parseProjectScopeFromStorageKey(key);
  if (!projectScope) {
    return false;
  }

  const scopedProject = await prisma.project.findFirst({
    where: {
      id: projectId,
      OR: [
        { id: projectScope },
        { slug: projectScope }
      ]
    },
    select: { id: true }
  });

  return Boolean(scopedProject);
}

export async function assertProjectStorageKeyAccess(projectId: string, storageKey: string) {
  if (!(await storageKeyBelongsToProject(projectId, storageKey))) {
    throw new HttpError(403, "Storage object does not belong to this project", "forbidden_storage_key");
  }
  return storageKey.trim();
}
