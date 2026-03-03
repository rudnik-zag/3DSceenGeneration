import Link from "next/link";
import { notFound } from "next/navigation";
import { promises as fs } from "fs";
import path from "path";

import { ViewerLoader } from "@/components/viewer/viewer-loader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { prisma } from "@/lib/db";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";
import { isRenderableInViewer, selectViewerRenderer } from "@/lib/viewer/renderer-switch";

interface SceneResultManifest {
  mesh_objects_dir?: string;
  output_paths?: {
    mesh_objects_dir?: string;
  };
}

function getLocalStorageRoot() {
  const configured = process.env.LOCAL_STORAGE_ROOT?.trim();
  return configured && configured.length > 0
    ? path.resolve(configured)
    : path.join(process.cwd(), ".local-storage");
}

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function toStorageKeyFromLocalPath(localRoot: string, absolutePath: string): string | null {
  const normalizedRoot = path.resolve(localRoot);
  const normalizedPath = path.resolve(absolutePath);
  const rootPrefix = `${normalizedRoot}${path.sep}`;

  if (normalizedPath.startsWith(rootPrefix)) {
    return toPosixPath(normalizedPath.slice(rootPrefix.length));
  }

  const projectsToken = `${path.sep}projects${path.sep}`;
  const projectsIndex = normalizedPath.lastIndexOf(projectsToken);
  if (projectsIndex >= 0) {
    return toPosixPath(normalizedPath.slice(projectsIndex + 1));
  }

  return null;
}

function parseManifest(raw: string): SceneResultManifest | null {
  try {
    return JSON.parse(raw) as SceneResultManifest;
  } catch {
    return null;
  }
}

function toUniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function resolveAdditionalSceneUrlsFromManifest(input: {
  projectId: string;
  projectName: string;
  runId: string;
  nodeId: string;
}): Promise<string[]> {
  const localRoot = getLocalStorageRoot();
  const projectSlug = resolveProjectStorageSlug({
    projectName: input.projectName,
    projectId: input.projectId
  });
  const projectSegments = toUniqueStrings([projectSlug, input.projectId]);

  const manifestCandidates = projectSegments.map((segment) =>
    path.join(
      localRoot,
      "projects",
      segment,
      "runs",
      input.runId,
      "nodes",
      input.nodeId,
      "scene_generation",
      "outputs",
      "result_manifest.json"
    )
  );

  for (const manifestPath of manifestCandidates) {
    try {
      const rawManifest = await fs.readFile(manifestPath, "utf8");
      const manifest = parseManifest(rawManifest);
      if (!manifest) continue;

      const rawMeshObjectsDir =
        typeof manifest.output_paths?.mesh_objects_dir === "string"
          ? manifest.output_paths.mesh_objects_dir
          : typeof manifest.mesh_objects_dir === "string"
            ? manifest.mesh_objects_dir
            : "";
      if (!rawMeshObjectsDir) continue;

      const primaryMeshDir = path.isAbsolute(rawMeshObjectsDir)
        ? rawMeshObjectsDir
        : path.resolve(path.dirname(manifestPath), rawMeshObjectsDir);
      const fallbackMeshDir = path.resolve(process.cwd(), rawMeshObjectsDir);
      const meshObjectsDir = await fs
        .access(primaryMeshDir)
        .then(() => primaryMeshDir)
        .catch(async () =>
          fs
            .access(fallbackMeshDir)
            .then(() => fallbackMeshDir)
            .catch(() => null)
        );
      if (!meshObjectsDir) continue;

      const files = await fs.readdir(meshObjectsDir);
      const glbPaths = files
        .filter((fileName) => fileName.toLowerCase().endsWith(".glb"))
        .sort((a, b) => a.localeCompare(b))
        .map((fileName) => path.join(meshObjectsDir, fileName));
      if (glbPaths.length === 0) continue;

      const storageKeys = glbPaths
        .map((absoluteFilePath) => toStorageKeyFromLocalPath(localRoot, absoluteFilePath))
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (storageKeys.length === 0) continue;

      const urls = (
        await Promise.all(storageKeys.map((storageKey) => safeGetSignedDownloadUrl(storageKey)))
      ).filter((value): value is string => typeof value === "string" && value.length > 0);

      if (urls.length > 0) {
        return toUniqueStrings(urls);
      }
    } catch {
      // Keep searching candidates and fall back to artifact metadata.
    }
  }

  return [];
}

function buildViewerHref(projectId: string, payload: { artifactId?: string; nodeId?: string }) {
  const params = new URLSearchParams();
  if (payload.artifactId) params.set("artifactId", payload.artifactId);
  if (payload.nodeId) params.set("nodeId", payload.nodeId);
  const query = params.toString();
  return query ? `/app/p/${projectId}/viewer?${query}` : `/app/p/${projectId}/viewer`;
}

export default async function ViewerPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ artifactId?: string; nodeId?: string }>;
}) {
  const { projectId } = await params;
  const { artifactId, nodeId } = await searchParams;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    notFound();
  }

  const projectArtifacts = await prisma.artifact.findMany({
    where: {
      projectId
    },
    orderBy: { createdAt: "desc" },
    take: 120
  });

  const artifacts = projectArtifacts.filter((artifact) =>
    isRenderableInViewer({
      kind: artifact.kind,
      storageKey: artifact.storageKey,
      meta: artifact.meta as Record<string, unknown> | null
    })
  );

  const scopedArtifacts = nodeId ? artifacts.filter((artifact) => artifact.nodeId === nodeId) : [];
  const artifactList = scopedArtifacts.length > 0 ? scopedArtifacts : artifacts;
  const selectedArtifact =
    artifactList.find((artifact) => artifact.id === artifactId) ??
    (artifactId ? artifacts.find((artifact) => artifact.id === artifactId) ?? null : null) ??
    artifactList[0] ??
    null;
  const activeNodeScope = scopedArtifacts.length > 0 ? (nodeId ?? selectedArtifact?.nodeId ?? null) : null;
  const selectedRenderer = selectedArtifact
    ? selectViewerRenderer({
        kind: selectedArtifact.kind,
        storageKey: selectedArtifact.storageKey,
        meta: selectedArtifact.meta as Record<string, unknown> | null
      })
    : null;
  let initialArtifact:
    | {
        id: string;
        kind: string;
        url: string;
        mimeType: string;
        meta: Record<string, unknown> | null;
        byteSize: number;
        storageKey: string;
        filename: string;
        additionalSceneUrls: string[];
      }
    | null = null;
  let storageIssue:
    | {
        title: string;
        description: string;
      }
    | null = null;

  if (selectedArtifact) {
    const exists = await storageObjectExists(selectedArtifact.storageKey);

    if (!exists) {
      storageIssue = {
        title: "Artifact File Missing",
        description: `storageKey=${selectedArtifact.storageKey}`
      };
    } else {
      const signedUrl = await safeGetSignedDownloadUrl(selectedArtifact.storageKey);
      if (!signedUrl) {
        storageIssue = {
          title: "Artifact Storage Unavailable",
          description: "Could not generate signed URL from configured S3/MinIO endpoint."
        };
      } else {
        const artifactMeta = selectedArtifact.meta as Record<string, unknown> | null;
        const metadataAdditionalSceneKeys =
          artifactMeta && Array.isArray(artifactMeta.meshObjectStorageKeys)
            ? artifactMeta.meshObjectStorageKeys.filter(
                (value): value is string => typeof value === "string" && value.length > 0
              )
            : [];
        const manifestAdditionalSceneUrls =
          selectedArtifact.kind === "mesh_glb"
            ? await resolveAdditionalSceneUrlsFromManifest({
                projectId: project.id,
                projectName: project.name,
                runId: selectedArtifact.runId,
                nodeId: selectedArtifact.nodeId
              })
            : [];
        const metadataAdditionalSceneUrls = (
          await Promise.all(metadataAdditionalSceneKeys.map(async (key) => safeGetSignedDownloadUrl(key)))
        ).filter((value): value is string => typeof value === "string" && value.length > 0);
        const additionalSceneUrls = toUniqueStrings([
          ...manifestAdditionalSceneUrls,
          ...metadataAdditionalSceneUrls
        ]);

        initialArtifact = {
          id: selectedArtifact.id,
          kind: selectedArtifact.kind,
          url: signedUrl,
          mimeType: selectedArtifact.mimeType,
          meta: artifactMeta,
          byteSize: selectedArtifact.byteSize,
          storageKey: selectedArtifact.storageKey,
          additionalSceneUrls,
          filename:
            (artifactMeta?.filename as string | undefined) ??
            selectedArtifact.storageKey.split("/").pop() ??
            selectedArtifact.id
        };
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {selectedArtifact ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 panel-blur p-3">
          <Badge className="rounded-full border border-border/70 bg-background/65">{selectedArtifact.kind}</Badge>
          {activeNodeScope ? (
            <Badge className="rounded-full border border-border/70 bg-background/65">Node {activeNodeScope}</Badge>
          ) : null}
          {selectedRenderer ? (
            <Badge className="rounded-full border border-border/70 bg-background/65">
              {selectedRenderer === "babylon-gs" ? "Babylon GS" : "Three.js"}
            </Badge>
          ) : null}
          <span className="text-sm text-muted-foreground">Artifact {selectedArtifact.id}</span>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="rounded-xl">
                  Select artifact
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[320px] rounded-xl border-border/70 bg-background/95 p-1">
                <ScrollArea className="h-[40vh]">
                  {artifactList.map((artifact) => (
                    <DropdownMenuItem key={artifact.id} asChild className="rounded-lg">
                      <Link
                        href={buildViewerHref(projectId, {
                          artifactId: artifact.id,
                          nodeId: activeNodeScope ?? undefined
                        })}
                      >
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Badge variant={artifact.id === selectedArtifact.id ? "default" : "secondary"} className="rounded-full">
                            {artifact.kind}
                          </Badge>
                          <span className="truncate text-xs text-muted-foreground">
                            {new Date(artifact.createdAt).toLocaleString()} · {artifact.id}
                          </span>
                        </span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </ScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : (
        <Card className="rounded-2xl border-border/70 panel-blur">
          <CardHeader className="pb-3">
            <CardTitle className="text-white">No pipeline artifacts yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>You can still open a local `.ply` / `.glb` file right now.</p>
            <Button asChild className="rounded-xl">
              <Link href={`/app/p/${projectId}/canvas`}>Open canvas</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {storageIssue ? (
        <Card className="rounded-2xl border-amber-300/40 bg-amber-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-amber-100">{storageIssue.title}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-amber-200/90">
            <p>{storageIssue.description}</p>
          </CardContent>
        </Card>
      ) : null}

      <ViewerLoader initialArtifact={initialArtifact} />
    </div>
  );
}
