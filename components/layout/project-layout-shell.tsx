"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ProjectNav } from "@/components/layout/project-nav";
import { Badge } from "@/components/ui/badge";

interface ProjectLayoutShellProps {
  projectName: string;
  counts: {
    graphs: number;
    runs: number;
    artifacts: number;
  };
  nav: Array<{ href: string; label: string }>;
  children: React.ReactNode;
}

export function ProjectLayoutShell({ projectName, counts, nav, children }: ProjectLayoutShellProps) {
  const pathname = usePathname();
  const isImmersiveRoute = pathname.includes("/viewer") || pathname.includes("/canvas");

  if (isImmersiveRoute) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
        <div className="border-b border-border/70 panel-blur px-3 py-2 md:px-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href="/app"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md studio-chip text-zinc-300 motion-fast hover:border-primary/35 hover:text-white"
                aria-label="Back to projects"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-white md:text-base">{projectName}</h1>
              </div>
            </div>
            <ProjectNav items={nav} variant="underline" className="shrink-0 justify-self-center" />
            <div />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/70 panel-blur p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white md:text-2xl">{projectName}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Project workspace</p>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/60">
              {counts.graphs} graphs
            </Badge>
            <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/60">
              {counts.runs} runs
            </Badge>
            <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/60">
              {counts.artifacts} artifacts
            </Badge>
          </div>
        </div>

        <ProjectNav items={nav} />
      </div>

      {children}
    </div>
  );
}
