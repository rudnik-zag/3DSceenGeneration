import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import Link from "next/link";

import { ViewerLoader } from "@/components/viewer/viewer-loader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageProjectAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { resolveProjectStorageSlug } from "@/lib/storage/project-path";
import { safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";
import { isRenderableInViewer, selectViewerRenderer } from "@/lib/viewer/renderer-switch";

type BundleMode = "same_node" | "project_fallback";

interface NodeMetaInfo {
  id: string;
  type: string;
  label: string | null;
}

interface SceneResultManifest {
  scene_path?: string;
  objects?: Array<{
    transformed_object_path?: string;
  }>;
  mesh_objects_dir?: string;
  output_paths?: {
    scene?: string;
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

async function sha256File(filePath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return null;
  }
}

function toUniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function toUniqueSignedUrlsByAssetPath(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    if (!rawValue || rawValue.length === 0) continue;
    let key = rawValue;
    try {
      const parsed = new URL(rawValue, "http://localhost");
      const storageKey = parsed.searchParams.get("key");
      key =
        parsed.pathname === "/api/storage/object" && storageKey && storageKey.length > 0
          ? `storage:${storageKey}`
          : `path:${parsed.origin}${parsed.pathname}`;
    } catch {
      key = rawValue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rawValue);
  }
  return result;
}

async function resolveAdditionalSceneUrlsFromManifest(input: {
  projectId: string;
  projectName: string;
  projectSlug?: string | null;
  runId: string;
  nodeId: string;
  storageKey?: string;
}): Promise<string[]> {
  const localRoot = getLocalStorageRoot();
  const projectSlug = resolveProjectStorageSlug({
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    projectId: input.projectId
  });
  const projectSegments = toUniqueStrings([projectSlug, input.projectId]);

  const legacyManifestCandidates = projectSegments.map((segment) =>
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
  const readableMatch =
    typeof input.storageKey === "string" && input.storageKey.length > 0
      ? input.storageKey.match(/^projects\/([^/]+)\/runs\/([^/]+)\/steps\/([^/]+)\/(attempt-\d{2})\/outputs\/[^/]+$/)
      : null;
  const readableManifestCandidates =
    readableMatch && readableMatch[1] && readableMatch[2] && readableMatch[3] && readableMatch[4]
      ? [
          path.join(
            localRoot,
            "projects",
            readableMatch[1],
            "runs",
            readableMatch[2],
            "steps",
            readableMatch[3],
            readableMatch[4],
            "scene_generation",
            "outputs",
            "result_manifest.json"
          )
        ]
      : [];
  const manifestCandidates = toUniqueStrings([...readableManifestCandidates, ...legacyManifestCandidates]);

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
      const rawScenePath =
        typeof manifest.output_paths?.scene === "string"
          ? manifest.output_paths.scene
          : typeof manifest.scene_path === "string"
            ? manifest.scene_path
            : "";

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

      const manifestObjectPaths = Array.isArray(manifest.objects)
        ? manifest.objects
            .map((entry) =>
              typeof entry?.transformed_object_path === "string" ? entry.transformed_object_path : ""
            )
            .filter((value) => value.length > 0)
        : [];
      const resolvedObjectPaths = manifestObjectPaths
        .map((value) => (path.isAbsolute(value) ? value : path.resolve(path.dirname(manifestPath), value)))
        .filter((value) => value.toLowerCase().endsWith(".glb"));

      let glbPaths: string[] = [];
      if (resolvedObjectPaths.length > 0) {
        glbPaths = [...resolvedObjectPaths].sort((a, b) => a.localeCompare(b));
      } else {
        const files = await fs.readdir(meshObjectsDir);
        glbPaths = files
          .filter((fileName) => fileName.toLowerCase().endsWith(".glb"))
          .sort((a, b) => a.localeCompare(b))
          .map((fileName) => path.join(meshObjectsDir, fileName));
      }
      if (glbPaths.length === 0) continue;

      // Legacy runs may include both scene.glb and per-object GLBs.
      // For new runs, scene_path points to object_000_posed.glb, so we must not filter it out.
      // Apply scene-hash filtering only when manifest does not explicitly provide objects[].
      if (resolvedObjectPaths.length === 0) {
        const resolvedScenePath = rawScenePath
          ? path.isAbsolute(rawScenePath)
            ? rawScenePath
            : path.resolve(path.dirname(manifestPath), rawScenePath)
          : null;
        const sceneHash = resolvedScenePath ? await sha256File(resolvedScenePath) : null;
        const glbHashCache = new Map<string, string | null>();
        const filteredGlbPaths: string[] = [];
        for (const glbPath of glbPaths) {
          if (resolvedScenePath && path.resolve(glbPath) === path.resolve(resolvedScenePath)) {
            continue;
          }
          if (sceneHash) {
            const existing = glbHashCache.get(glbPath);
            const glbHash = existing === undefined ? await sha256File(glbPath) : existing;
            if (existing === undefined) glbHashCache.set(glbPath, glbHash);
            if (glbHash && glbHash === sceneHash) {
              continue;
            }
          }
          filteredGlbPaths.push(glbPath);
        }
        if (filteredGlbPaths.length > 0) {
          glbPaths = filteredGlbPaths;
        }
      }

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

function buildViewerHref(projectId: string, payload: { artifactId?: string; nodeId?: string; bundleMode?: BundleMode }) {
  const params = new URLSearchParams();
  if (payload.artifactId) params.set("artifactId", payload.artifactId);
  if (payload.nodeId) params.set("nodeId", payload.nodeId);
  if (payload.bundleMode) params.set("bundleMode", payload.bundleMode);
  const query = params.toString();
  return query ? `/app/p/${projectId}/viewer?${query}` : `/app/p/${projectId}/viewer`;
}

function isTruthyQuery(value: string | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function parseNodeMetaMap(rawGraph: unknown) {
  const map = new Map<string, NodeMetaInfo>();
  if (!rawGraph || typeof rawGraph !== "object" || Array.isArray(rawGraph)) return map;
  const record = rawGraph as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  for (const entry of nodes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const node = entry as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : "";
    const type = typeof node.type === "string" ? node.type : "";
    if (!id || !type) continue;
    const data =
      node.data && typeof node.data === "object" && !Array.isArray(node.data)
        ? (node.data as Record<string, unknown>)
        : null;
    const label = data && typeof data.label === "string" && data.label.trim().length > 0 ? data.label.trim() : null;
    map.set(id, {
      id,
      type,
      label
    });
  }
  return map;
}

export default async function ViewerPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ artifactId?: string; nodeId?: string; bundleMode?: string; empty?: string }>;
}) {
  const { projectId } = await params;
  const { artifactId, nodeId, empty } = await searchParams;
  const openEmptyViewer = isTruthyQuery(empty);
  const selectedBundleMode: BundleMode = "same_node";

  const access = await requirePageProjectAccess(projectId, "viewer");
  const project = access.project;

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

  const hasViewerContext = Boolean(artifactId || nodeId || openEmptyViewer);
  if (!hasViewerContext) {
    const latestGraph = await prisma.graph.findFirst({
      where: {
        projectId
      },
      orderBy: [{ version: "desc" }, { updatedAt: "desc" }],
      select: {
        graphJson: true
      }
    });
    const nodeMetaMap = parseNodeMetaMap(latestGraph?.graphJson ?? null);

    const groupedByNode = artifacts.reduce<
      Array<{
        nodeId: string;
        nodeType: string;
        nodeLabel: string | null;
        items: typeof artifacts;
        latestAt: number;
      }>
    >((acc, artifact) => {
      const existing = acc.find((entry) => entry.nodeId === artifact.nodeId);
      const nodeMeta = nodeMetaMap.get(artifact.nodeId);
      if (existing) {
        existing.items.push(artifact);
        existing.latestAt = Math.max(existing.latestAt, artifact.createdAt.getTime());
        return acc;
      }
      acc.push({
        nodeId: artifact.nodeId,
        nodeType: nodeMeta?.type ?? artifact.nodeId.split("-")[0] ?? "unknown",
        nodeLabel: nodeMeta?.label ?? null,
        items: [artifact],
        latestAt: artifact.createdAt.getTime()
      });
      return acc;
    }, []);

    for (const group of groupedByNode) {
      group.items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    groupedByNode.sort((a, b) => b.latestAt - a.latestAt);

    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <Card className="rounded-2xl border-border/70 panel-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-white">Choose Viewer Source</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-zinc-300">
            <p>Select node/version to open in viewer, or start with an empty scene.</p>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/app/p/${projectId}/viewer?empty=1`}
                className="inline-flex h-9 items-center justify-center rounded-md border border-border/70 bg-background/60 px-3 text-xs text-zinc-100 transition hover:bg-white/10"
              >
                Open Empty Viewer
              </Link>
            </div>
          </CardContent>
        </Card>

        {groupedByNode.length === 0 ? (
          <Card className="rounded-2xl border-border/70 panel-blur">
            <CardContent className="py-6 text-sm text-muted-foreground">
              No scene artifacts found yet. Run `CustomSceneGeneration` node first.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {groupedByNode.map((group) => (
              <Card key={group.nodeId} className="rounded-2xl border-border/70 panel-blur">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-white">
                    {group.nodeLabel ?? group.nodeType}
                  </CardTitle>
                  <p className="text-xs text-zinc-400">{group.nodeId}</p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {group.items.slice(0, 8).map((artifact) => (
                    <Link
                      key={artifact.id}
                      href={buildViewerHref(projectId, {
                        artifactId: artifact.id,
                        nodeId: group.nodeId,
                        bundleMode: selectedBundleMode
                      })}
                      className="flex items-center justify-between rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-xs text-zinc-200 transition hover:bg-white/10"
                    >
                      <span>{artifact.kind}</span>
                      <span className="text-zinc-400">
                        {new Date(artifact.createdAt).toLocaleString()} · {shortId(artifact.id)}
                      </span>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  const scopedArtifacts = nodeId ? artifacts.filter((artifact) => artifact.nodeId === nodeId) : [];
  const artifactList = artifacts;
  let selectedArtifact = artifactId
    ? artifacts.find((artifact) => artifact.id === artifactId) ?? null
    : nodeId
      ? scopedArtifacts[0] ?? null
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
  let firstMissingStorageKey: string | null = null;
  let sawStorageUnavailable = false;
  const hydrateInitialArtifact = async (candidate: (typeof artifactList)[number]) => {
    const exists = await storageObjectExists(candidate.storageKey);
    if (!exists) {
      if (!firstMissingStorageKey) {
        firstMissingStorageKey = candidate.storageKey;
      }
      return null;
    }

    const signedUrl = await safeGetSignedDownloadUrl(candidate.storageKey);
    if (!signedUrl) {
      sawStorageUnavailable = true;
      return null;
    }

    const artifactMeta = candidate.meta as Record<string, unknown> | null;
    const metadataAdditionalSceneKeys =
      artifactMeta && Array.isArray(artifactMeta.meshObjectStorageKeys)
        ? artifactMeta.meshObjectStorageKeys.filter(
            (value): value is string => typeof value === "string" && value.length > 0
          )
        : [];
    const manifestAdditionalSceneUrls =
      candidate.kind === "mesh_glb"
        ? await resolveAdditionalSceneUrlsFromManifest({
            projectId: project.id,
            projectName: project.name,
            projectSlug: project.slug,
            runId: candidate.runId,
            nodeId: candidate.nodeId,
            storageKey: candidate.storageKey
          })
        : [];
    const metadataAdditionalSceneUrls = (
      await Promise.all(metadataAdditionalSceneKeys.map(async (key) => safeGetSignedDownloadUrl(key)))
    ).filter((value): value is string => typeof value === "string" && value.length > 0);
    const additionalSceneUrls = toUniqueSignedUrlsByAssetPath(
      manifestAdditionalSceneUrls.length > 0 ? manifestAdditionalSceneUrls : metadataAdditionalSceneUrls
    );

    return {
      id: candidate.id,
      kind: candidate.kind,
      url: signedUrl,
      mimeType: candidate.mimeType,
      meta: artifactMeta,
      byteSize: candidate.byteSize,
      storageKey: candidate.storageKey,
      additionalSceneUrls,
      filename:
        (artifactMeta?.filename as string | undefined) ??
        candidate.storageKey.split("/").pop() ??
        candidate.id
    };
  };

  const candidateArtifacts = selectedArtifact ? [selectedArtifact] : [];
  for (const candidate of candidateArtifacts) {
    const hydrated = await hydrateInitialArtifact(candidate);
    if (!hydrated) continue;
    selectedArtifact = candidate;
    initialArtifact = hydrated;
    storageIssue = null;
    break;
  }

  if (!initialArtifact) {
    if (firstMissingStorageKey) {
      storageIssue = {
        title: "Artifact File Missing",
        description: `storageKey=${firstMissingStorageKey}`
      };
    } else if (sawStorageUnavailable) {
      storageIssue = {
        title: "Artifact Storage Unavailable",
        description: "Could not generate signed URL from configured S3/MinIO endpoint."
      };
    }
  }

  const activeNodeScope = nodeId ?? selectedArtifact?.nodeId ?? null;
  const pickerArtifacts = activeNodeScope
    ? artifactList.filter((artifact) => artifact.nodeId === activeNodeScope)
    : artifactList;
  const selectedRenderer = selectedArtifact
    ? selectViewerRenderer({
        kind: selectedArtifact.kind,
        storageKey: selectedArtifact.storageKey,
        meta: selectedArtifact.meta as Record<string, unknown> | null
      })
    : null;
  const artifactPicker =
    selectedArtifact && pickerArtifacts.length > 0
      ? {
          selectedKind: selectedArtifact.kind,
          selectedArtifactText: `Artifact ${selectedArtifact.id}`,
          activeNodeScope,
          rendererLabel:
            selectedRenderer === "spark-gs"
              ? "Spark GS"
              : selectedRenderer === "babylon-gs"
                ? "Legacy GS"
                : selectedRenderer === "three"
                  ? "Three.js"
                  : null,
          options: pickerArtifacts.map((artifact) => ({
            id: artifact.id,
            kind: artifact.kind,
            href: buildViewerHref(projectId, {
              artifactId: artifact.id,
              nodeId: activeNodeScope ?? undefined,
              bundleMode: selectedBundleMode
            }),
            label: `${new Date(artifact.createdAt).toLocaleString()} · ${artifact.id}`,
            selected: artifact.id === selectedArtifact?.id
          }))
        }
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {openEmptyViewer ? (
        <Card className="mb-2 rounded-2xl border-sky-300/30 bg-sky-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sky-100">Empty Viewer Mode</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-sky-100/90">
            Scene started empty. Load a local file, add external object, or open a node version from chooser.
          </CardContent>
        </Card>
      ) : null}
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

      <ViewerLoader
        initialArtifact={initialArtifact}
        artifactPicker={artifactPicker}
        initialBundleMode={selectedBundleMode}
        startEmpty={openEmptyViewer && !initialArtifact}
      />
    </div>
  );
}
