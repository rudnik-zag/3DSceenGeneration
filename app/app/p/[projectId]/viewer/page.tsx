import Link from "next/link";
import { notFound } from "next/navigation";

import { ViewerLoader } from "@/components/viewer/viewer-loader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { prisma } from "@/lib/db";
import { safeGetSignedDownloadUrl, storageObjectExists } from "@/lib/storage/s3";
import { isRenderableInViewer, selectViewerRenderer } from "@/lib/viewer/renderer-switch";

export default async function ViewerPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ artifactId?: string }>;
}) {
  const { projectId } = await params;
  const { artifactId } = await searchParams;

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

  const selectedArtifact = artifacts.find((a) => a.id === artifactId) ?? artifacts[0] ?? null;
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
        initialArtifact = {
          id: selectedArtifact.id,
          kind: selectedArtifact.kind,
          url: signedUrl,
          mimeType: selectedArtifact.mimeType,
          meta: selectedArtifact.meta as Record<string, unknown> | null,
          byteSize: selectedArtifact.byteSize,
          storageKey: selectedArtifact.storageKey,
          filename:
            ((selectedArtifact.meta as Record<string, unknown> | null)?.filename as string | undefined) ??
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
                  {artifacts.map((artifact) => (
                    <DropdownMenuItem key={artifact.id} asChild className="rounded-lg">
                      <Link href={`/app/p/${projectId}/viewer?artifactId=${artifact.id}`}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <Badge variant={artifact.id === selectedArtifact.id ? "default" : "secondary"} className="rounded-full">
                            {artifact.kind}
                          </Badge>
                          <span className="truncate text-xs text-muted-foreground">{artifact.id}</span>
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
