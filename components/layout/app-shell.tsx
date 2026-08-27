"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Sparkles } from "lucide-react";

import { TokenStatusChip } from "@/components/billing/token-status-chip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AppShell({
  currentUserLabel,
  children
}: {
  currentUserLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isImmersiveRoute = pathname.includes("/viewer") || pathname.includes("/graph-editor");

  return (
    <div className="min-h-screen studio-dot-bg">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#18181a]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1900px] items-center justify-between px-3 md:px-6">
          <div className="flex items-center gap-2">
            <Link href="/app" className="inline-flex items-center gap-3 text-sm font-medium tracking-wide text-foreground md:text-base">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-[#18181a]">
                <Sparkles className="h-4 w-4" />
              </span>
              <span>3D AI Studio</span>
            </Link>
          </div>

          <TokenStatusChip />

          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-zinc-500 md:inline">{currentUserLabel}</span>
            {!isImmersiveRoute ? (
              <Button variant="ghost" size="sm" className="rounded-xl text-xs md:text-sm" asChild>
                <Link href="/billing">Billing</Link>
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="rounded-xl text-xs md:text-sm" asChild>
              <Link href="/settings">{isImmersiveRoute ? "Prefs" : "Settings"}</Link>
            </Button>
            {!isImmersiveRoute ? (
              <Button variant="ghost" size="sm" className="rounded-xl text-xs md:text-sm" asChild>
                <Link href="/">Landing</Link>
              </Button>
            ) : null}
            {isImmersiveRoute ? (
              <Button variant="ghost" size="sm" className="rounded-xl text-xs md:text-sm" asChild>
                <Link href="/app">Projects</Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg border-white/20 bg-white text-xs text-[#18181a] hover:bg-zinc-200 md:text-sm"
              onClick={() => {
                void signOut({ callbackUrl: "/login" });
              }}
            >
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto min-h-[calc(100vh-3.5rem)] max-w-[1900px]",
          isImmersiveRoute ? "p-0" : "p-3 md:p-6"
        )}
      >
        {children}
      </main>
    </div>
  );
}
