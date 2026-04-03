"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  Cable,
  Eye,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";

export interface ProjectItem {
  id: string;
  name: string;
  previewArtifactId?: string | null;
  previewStorageKey?: string | null;
  previewMimeType?: string | null;
  previewUpdatedAt?: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  _count: {
    graphs: number;
    runs: number;
  };
}

type ProjectStatus = "success" | "running" | "new";

function deriveProjectStatus(project: ProjectItem): ProjectStatus {
  if (project._count.runs === 0) return "new";
  const updatedAt = +new Date(project.updatedAt);
  const hoursSinceUpdate = (Date.now() - updatedAt) / (1000 * 60 * 60);
  if (hoursSinceUpdate < 24) return "running";
  return "success";
}

function formatCardDate(value: string | Date) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}

export function DashboardClient({ initialProjects }: { initialProjects: ProjectItem[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [brokenPreviewIds, setBrokenPreviewIds] = useState<Record<string, true>>({});
  const [loadedPreviewIds, setLoadedPreviewIds] = useState<Record<string, true>>({});
  const [name, setName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const router = useRouter();

  const sorted = useMemo(
    () => [...projects].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [projects]
  );

  const filtered = useMemo(
    () => sorted.filter((project) => project.name.toLowerCase().includes(search.toLowerCase())),
    [sorted, search]
  );

  const createProject = async (rawName?: string) => {
    const projectName = (rawName ?? name).trim();
    if (!projectName) {
      toast({ title: "Project name required", description: "Enter a name before creating the project." });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName })
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        const message =
          payload?.message ??
          (payload?.error ? `Create project failed: ${payload.error}` : "Failed to create project");
        throw new Error(message);
      }
      const data = await res.json();
      setProjects((prev) => [
        {
          ...data.project,
          previewArtifactId: null,
          previewStorageKey: null,
          previewMimeType: null,
          previewUpdatedAt: null,
          _count: { graphs: 1, runs: 0 }
        },
        ...prev
      ]);
      setName("");
      setCreateOpen(false);
      toast({ title: "Project created", description: data.project.name });
      router.push(`/app/p/${data.project.id}/canvas`);
      router.refresh();
    } catch (error) {
      toast({ title: "Create project failed", description: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  };

  const deleteProject = async (projectId: string, projectName: string) => {
    const confirmed = window.confirm(`Delete project "${projectName}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeletingId(projectId);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        throw new Error("Failed to delete project");
      }

      setProjects((prev) => prev.filter((project) => project.id !== projectId));
      toast({ title: "Project deleted", description: projectName });
      router.refresh();
    } catch (error) {
      toast({ title: "Delete failed", description: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-5">
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-2xl border-border/70 panel-blur sm:max-w-[520px]">
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <DialogHeader className="space-y-1">
              <DialogTitle className="text-white">Create Project</DialogTitle>
              <DialogDescription>Give your project a name and start from the canvas.</DialogDescription>
            </DialogHeader>

            <div className="space-y-2.5">
              <Label htmlFor="project-name" className="text-sm text-zinc-200">
                Project name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 rounded-xl border-border/70 bg-background/70 focus-visible:border-primary/50"
                placeholder="Project name"
              />
            </div>

            <DialogFooter className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full rounded-xl"
                onClick={() => setCreateOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" className="h-11 w-full rounded-xl" disabled={loading || !name.trim()}>
                {loading ? "Creating..." : "Create Project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <section className="rounded-2xl border border-[#2a3559] bg-[#0b1226]/90 shadow-[0_20px_65px_rgba(1,8,25,0.48)] backdrop-blur">
        <div className="flex flex-wrap items-center gap-3 border-b border-[#263254] px-4 py-3 md:px-5">
          <div className="inline-flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-[#5d57f4] text-white shadow-[0_6px_18px_rgba(93,87,244,0.45)]">
              <Sparkles className="h-4 w-4" />
            </div>
            <p className="text-lg font-semibold tracking-tight text-white">TribalAI</p>
            <span className="rounded-full border border-[#41528a] bg-[#1a2550]/75 px-2 py-0.5 text-[10px] text-[#a8b7f2]">
              Studio
            </span>
          </div>

          <div className="ml-auto flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative sm:w-[320px]">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[#7f8db7]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 rounded-lg border-[#334068] bg-[#141f3f]/95 pl-9 text-[#d5defc] placeholder:text-[#7f8db7] focus-visible:border-[#5f76d1]"
                placeholder="Search projects..."
              />
            </div>
            <Button className="h-10 rounded-lg bg-[#5b58f3] px-4 text-white hover:bg-[#6a67ff]" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Project
            </Button>
          </div>
        </div>

        <div className="p-4 md:p-5">
          <div className="relative overflow-hidden rounded-2xl border border-[#2a3c6b] bg-[#121f46] px-5 py-5 md:px-7 md:py-7">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_28%_25%,rgba(103,129,255,0.26),transparent_42%),radial-gradient(circle_at_76%_26%,rgba(71,171,218,0.24),transparent_36%),linear-gradient(120deg,rgba(7,14,32,0.8),rgba(8,22,52,0.48))]" />
            <div className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(circle_at_10%_90%,rgba(112,156,255,0.28),transparent_34%),radial-gradient(circle_at_86%_80%,rgba(69,211,201,0.2),transparent_36%)]" />

            <div className="relative z-10 grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight text-white">Welcome to TribalAI Studio</h2>
                <p className="mt-2 max-w-2xl text-lg leading-relaxed text-[#b3c0e4]">
                  Build AI-powered 2D-to-3D pipelines visually. Design workflows, run pipelines, and inspect generated
                  meshes and splats in one place.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button className="h-10 rounded-lg bg-[#5b58f3] px-4 text-white hover:bg-[#6a67ff]" onClick={() => setCreateOpen(true)}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Create First Project
                  </Button>
                  {sorted[0] ? (
                    <Button
                      variant="outline"
                      className="h-10 rounded-lg border-[#405488] bg-[#1a2950]/70 text-[#d0dbfb] hover:bg-[#23356a]"
                      onClick={() => router.push(`/app/p/${sorted[0].id}/canvas`)}
                    >
                      View Templates
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-[#33456f] bg-[#131f44]/70 p-3 text-center">
                  <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-[#2a3973] text-[#95b2ff]">
                    <Cable className="h-5 w-5" />
                  </div>
                  <p className="text-base font-semibold text-white">Design</p>
                  <p className="mt-1 text-xs text-[#a9b8df]">Build node pipelines</p>
                </div>
                <div className="rounded-xl border border-[#33456f] bg-[#131f44]/70 p-3 text-center">
                  <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-[#2a3973] text-[#95b2ff]">
                    <Play className="h-5 w-5" />
                  </div>
                  <p className="text-base font-semibold text-white">Execute</p>
                  <p className="mt-1 text-xs text-[#a9b8df]">Run and monitor</p>
                </div>
                <div className="rounded-xl border border-[#33456f] bg-[#131f44]/70 p-3 text-center">
                  <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-[#2a3973] text-[#95b2ff]">
                    <Eye className="h-5 w-5" />
                  </div>
                  <p className="text-base font-semibold text-white">Inspect</p>
                  <p className="mt-1 text-xs text-[#a9b8df]">View 3D outputs</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <h1 className="text-3xl font-semibold tracking-tight text-white">All Projects</h1>
            <p className="mt-1 text-sm text-[#8fa2d2]">{filtered.length} projects</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {filtered.map((project) => {
          const status = deriveProjectStatus(project);
          const statusClass =
            status === "success"
              ? "border-emerald-400/45 bg-emerald-500/20 text-emerald-200"
              : status === "running"
                ? "border-amber-400/45 bg-amber-500/18 text-amber-200"
                : "border-sky-400/45 bg-sky-500/18 text-sky-200";
          const statusLabel = status === "new" ? "new" : status;

          return (
            <Card
              key={project.id}
              className="group overflow-hidden rounded-2xl border border-[#2c3b67] bg-[#121c38]/90 shadow-[0_16px_36px_rgba(2,7,20,0.48)] motion-fast hover:-translate-y-0.5 hover:border-[#4f66a9]"
            >
              <CardHeader className="space-y-2 p-0">
                {project.previewStorageKey && !brokenPreviewIds[project.id] ? (
                  <div className="relative h-40 overflow-hidden border-b border-[#2e3d66] bg-black/30">
                    {!loadedPreviewIds[project.id] ? <div className="skeleton-shimmer absolute inset-0 bg-white/[0.04]" /> : null}
                    <img
                      src={`/api/storage/object?key=${encodeURIComponent(project.previewStorageKey)}`}
                      alt={`${project.name} preview`}
                      className={`h-full w-full object-cover motion-panel group-hover:scale-[1.03] ${
                        loadedPreviewIds[project.id] ? "opacity-100" : "opacity-0"
                      }`}
                      loading="lazy"
                      onLoad={() =>
                        setLoadedPreviewIds((prev) =>
                          prev[project.id]
                            ? prev
                            : {
                                ...prev,
                                [project.id]: true
                              }
                        )
                      }
                      onError={() =>
                        setBrokenPreviewIds((prev) =>
                          prev[project.id]
                            ? prev
                            : {
                                ...prev,
                                [project.id]: true
                              }
                        )
                      }
                    />
                    <span className={`absolute right-2 top-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                ) : (
                  <div className="relative h-40 border-b border-dashed border-[#344577] bg-[#0e1935] skeleton-shimmer">
                    <span className={`absolute right-2 top-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                )}

                <div className="space-y-1 px-3.5 pt-3">
                  <CardTitle className="line-clamp-1 text-[27px] font-semibold leading-none tracking-tight text-white">
                    {project.name}
                  </CardTitle>
                  <CardDescription className="line-clamp-2 text-sm leading-6 text-[#a2b0d9]">
                    {project._count.runs > 0
                      ? `${project._count.runs} workflow runs processed in this project.`
                      : "Start your first run by opening the canvas and executing a workflow."}
                  </CardDescription>
                </div>
              </CardHeader>

              <CardContent className="space-y-3 p-3.5 pt-2.5">
                <div className="flex items-center justify-between border-t border-[#25365d] pt-2 text-[12px] text-[#8797c4]">
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {formatCardDate(project.updatedAt)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Play className="h-3.5 w-3.5" />
                    {project._count.runs} runs
                  </span>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" className="h-8 flex-1 rounded-lg bg-[#1a8f72] text-white hover:bg-[#1ea783]" onClick={() => router.push(`/app/p/${project.id}/canvas`)}>
                    Open canvas
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg border-[#3c4f81] bg-[#16213f] text-[#c2d0f8] hover:bg-[#1f2d55]"
                    onClick={() => router.push(`/app/p/${project.id}/runs`)}
                  >
                    Runs
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-8 rounded-lg px-2.5"
                    onClick={() => void deleteProject(project.id, project.name)}
                    disabled={deletingId === project.id}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-[#2c3b67] bg-[#101a34] p-8 text-center text-sm text-[#93a7d9]">
          No projects found.
        </div>
      ) : null}
    </div>
  );
}
