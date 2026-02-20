import Link from "next/link";

import { Button } from "@/components/ui/button";

export function AppTopNav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-4 md:px-6">
        <Link href="/app" className="text-lg font-semibold">
          TribalAI Workflow Studio
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">Landing</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
