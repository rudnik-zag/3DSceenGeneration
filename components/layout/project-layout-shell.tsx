"use client";

import { usePathname } from "next/navigation";

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
    return <div className="h-[calc(100vh-3.5rem)] overflow-hidden">{children}</div>;
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
