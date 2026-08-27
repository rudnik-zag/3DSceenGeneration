import Link from "next/link";

import { Button } from "@/components/ui/button";

export function AppTopNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#18181a]/92 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1800px] items-center justify-between px-4 md:px-6">
        <Link href="/app" className="text-sm font-medium tracking-wide text-white">
          3D AI Studio
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
