"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface ShellProject {
  id: string;
  name: string;
}

function SidebarContent({ projects, onNavigate }: { projects: ShellProject[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [projects, query]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/70 p-4">
        <p className="text-sm font-medium text-muted-foreground">Workspace</p>
        <p className="truncate text-base font-semibold">Dusan Njegovanovic</p>
      </div>

      <div className="p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-9 rounded-xl border-border/70 bg-background/70 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects"
          />
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-14rem)] px-2">
        <nav className="space-y-1 p-2">
          <Link
            href="/app"
            onClick={onNavigate}
            className={cn(
              "block rounded-xl px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground",
              pathname === "/app" && "bg-accent text-foreground"
            )}
          >
            All Projects
          </Link>

          {filtered.map((project) => {
            const active = pathname.includes(`/app/p/${project.id}`);
            return (
              <Link
                key={project.id}
                href={`/app/p/${project.id}/canvas`}
                onClick={onNavigate}
                className={cn(
                  "block rounded-xl px-3 py-2 text-sm transition hover:bg-accent",
                  active ? "bg-accent text-foreground" : "text-muted-foreground"
                )}
              >
                {project.name}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>

      <div className="mt-auto p-3">
        <Button asChild className="h-9 w-full rounded-xl text-sm font-medium">
          <Link href="/app">
            <Plus className="mr-1.5 h-4 w-4" /> New Project
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function AppShell({
  projects,
  children
}: {
  projects: ShellProject[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isImmersiveRoute = pathname.includes("/viewer") || pathname.includes("/canvas");

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1900px] items-center justify-between px-3 md:px-6">
          <div className="flex items-center gap-2">
            {!isImmersiveRoute ? (
              <Button
                variant="ghost"
                size="icon"
                className="rounded-xl md:hidden"
                onClick={() => setOpen((v) => !v)}
                aria-label="Toggle menu"
              >
                {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </Button>
            ) : null}
            <Link href="/app" className="text-sm font-semibold tracking-wide text-foreground md:text-base">
              3D-AI Canvas
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="rounded-xl text-xs md:text-sm" asChild>
              <Link href="/">Landing</Link>
            </Button>
          </div>
        </div>
      </header>

      <div className={cn("mx-auto grid max-w-[1900px] grid-cols-1", !isImmersiveRoute && "md:grid-cols-[260px_1fr]")}>
        {!isImmersiveRoute ? (
          <aside className="hidden border-r border-border/70 panel-blur md:block">
            <SidebarContent projects={projects} />
          </aside>
        ) : null}

        {open && !isImmersiveRoute ? (
          <div className="fixed inset-0 z-40 bg-black/65 md:hidden" onClick={() => setOpen(false)}>
            <aside
              className="h-full w-[280px] border-r border-border/70 panel-blur"
              onClick={(e) => e.stopPropagation()}
            >
              <SidebarContent projects={projects} onNavigate={() => setOpen(false)} />
            </aside>
          </div>
        ) : null}

        <main className={cn("min-h-[calc(100vh-3.5rem)]", isImmersiveRoute ? "p-0" : "p-3 md:p-6")}>{children}</main>
      </div>
    </div>
  );
}
