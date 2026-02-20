"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export function ProjectNav({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();

  return (
    <div className="mt-4 inline-flex rounded-xl border border-border/70 bg-background/50 p-1">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
