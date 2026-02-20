"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";

export interface ProjectItem {
  id: string;
  name: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  _count: {
    graphs: number;
    runs: number;
  };
}

export function DashboardClient({ initialProjects }: { initialProjects: ProjectItem[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const sorted = useMemo(
    () => [...projects].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [projects]
  );

  const filtered = useMemo(
    () => sorted.filter((project) => project.name.toLowerCase().includes(search.toLowerCase())),
    [sorted, search]
  );

  const createProject = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!res.ok) {
        throw new Error("Failed to create project");
      }
      const data = await res.json();
      setProjects((prev) => [
        {
          ...data.project,
          _count: { graphs: 1, runs: 0 }
        },
        ...prev
      ]);
      setName("");
      toast({ title: "Project created", description: data.project.name });
      router.push(`/app/p/${data.project.id}/canvas`);
      router.refresh();
    } catch (error) {
      toast({ title: "Create project failed", description: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border/70 panel-blur p-4 md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">All Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">Create and manage your workflow canvases.</p>
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
            <div className="relative sm:min-w-[260px]">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-xl border-border/70 bg-background/70 pl-9"
                placeholder="Search"
              />
            </div>
            <Button className="h-9 rounded-xl" onClick={createProject} disabled={loading}>
              <Plus className="mr-1.5 h-4 w-4" />
              {loading ? "Creating..." : "New project"}
            </Button>
          </div>
        </div>
      </div>

      <Card className="rounded-2xl border-border/70 panel-blur">
        <CardHeader>
          <CardTitle className="text-base text-white">Quick Create</CardTitle>
          <CardDescription>Give the project a name and jump directly into the canvas.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-10 rounded-xl border-border/70 bg-background/70"
            placeholder="Project name"
          />
          <Button onClick={createProject} disabled={loading} className="h-10 rounded-xl">
            {loading ? "Creating..." : "Create"}
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((project) => (
          <Card
            key={project.id}
            className="group rounded-2xl border-border/70 panel-blur transition duration-200 hover:-translate-y-0.5 hover:border-primary/40"
          >
            <CardHeader>
              <div className="mb-2 h-40 rounded-xl border border-dashed border-border/90 bg-black/30" />
              <CardTitle className="line-clamp-1 text-white">{project.name}</CardTitle>
              <CardDescription>
                {project._count.graphs} graph versions • {project._count.runs} runs
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button size="sm" className="rounded-lg" onClick={() => router.push(`/app/p/${project.id}/canvas`)}>
                Open canvas
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => router.push(`/app/p/${project.id}/runs`)}
              >
                Runs
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
