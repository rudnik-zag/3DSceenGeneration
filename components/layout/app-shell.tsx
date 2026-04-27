"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

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
  const isImmersiveRoute = pathname.includes("/viewer") || pathname.includes("/canvas");

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1900px] items-center justify-between px-3 md:px-6">
          <div className="flex items-center gap-2">
            <Link href="/app" className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-foreground md:text-base">
              TribalAI
              <span className="rounded-full studio-chip px-2 py-0.5 text-[10px] font-medium">
                Studio
              </span>
            </Link>
          </div>

          <TokenStatusChip />

          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-zinc-400 md:inline">{currentUserLabel}</span>
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
              className="rounded-xl text-xs md:text-sm"
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
