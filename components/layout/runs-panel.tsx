"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";

interface ArtifactItem {
  id: string;
  kind: string;
  nodeId: string;
}

interface RunItem {
  id: string;
  status: "queued" | "running" | "success" | "error" | "canceled";
  progress: number;
  logs: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  graph: { id: string; name: string; version: number };
  artifacts: ArtifactItem[];
}

const statusVariant: Record<RunItem["status"], "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  success: "default",
  error: "destructive",
  canceled: "outline"
};

export function RunsPanel({ projectId, initialRuns }: { projectId: string; initialRuns: RunItem[] }) {
  const [runs, setRuns] = useState(initialRuns);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const hasActive = useMemo(() => runs.some((r) => r.status === "queued" || r.status === "running"), [runs]);

  const refreshRuns = async () => {
    const res = await fetch(`/api/projects/${projectId}/runs`, { cache: "no-store" });
    if (!res.ok) {
      return;
    }

    const data = await res.json();
    setRuns(
      (data.runs as RunItem[]).map((run) => ({
        ...run,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt
      }))
    );
  };

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    const timer = setInterval(() => {
      if (hasActive) {
        refreshRuns();
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [autoRefresh, hasActive]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Workflow Runs</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="rounded-xl" onClick={refreshRuns}>
            Refresh
          </Button>
          <Button className="rounded-xl" variant={autoRefresh ? "default" : "outline"} onClick={() => setAutoRefresh((v) => !v)}>
            Auto refresh {autoRefresh ? "on" : "off"}
          </Button>
        </div>
      </div>

      <Card className="rounded-2xl border-border/70 panel-blur">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Graph</TableHead>
                <TableHead>Artifacts</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-xs">{run.id.slice(0, 10)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant[run.status]}>{run.status}</Badge>
                  </TableCell>
                  <TableCell>{run.progress}%</TableCell>
                  <TableCell>
                    {run.graph.name} <span className="text-xs text-muted-foreground">v{run.graph.version}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {run.artifacts.map((artifact) => (
                        <Button
                          key={artifact.id}
                          size="sm"
                          variant="outline"
                          className="rounded-lg"
                          onClick={() =>
                            window.open(`/app/p/${projectId}/viewer?artifactId=${artifact.id}`, "_blank")
                          }
                        >
                          {artifact.kind}
                        </Button>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{new Date(run.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {runs[0] ? (
        <Card className="rounded-2xl border-border/70 panel-blur">
          <CardContent className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">Latest run logs</h3>
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => {
                  navigator.clipboard.writeText(runs[0].logs);
                  toast({ title: "Copied", description: "Logs copied to clipboard" });
                }}
              >
                Copy
              </Button>
            </div>
            <ScrollArea className="h-52 rounded-md border bg-muted/30 p-3">
              <pre className="whitespace-pre-wrap text-xs">{runs[0].logs || "No logs yet"}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
