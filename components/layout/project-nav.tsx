"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export function ProjectNav({
  items,
  variant = "pill",
  className
}: {
  items: Array<{ href: string; label: string }>;
  variant?: "pill" | "underline";
  className?: string;
}) {
  const pathname = usePathname();

  const wrapperClass =
    variant === "underline"
      ? "inline-flex gap-1 border-b border-border/60"
      : "inline-flex rounded-xl studio-panel p-1";

  return (
    <div className={cn(variant === "pill" && "mt-4", wrapperClass, className)}>
      {items.map((item) => {
        const active = pathname === item.href;
        const itemClass =
          variant === "underline"
            ? cn(
                "rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground motion-fast transition hover:border-primary/35 hover:text-foreground",
                active && "border-primary text-foreground"
              )
            : cn(
                "rounded-lg px-3 py-1.5 text-sm text-muted-foreground motion-fast transition hover:bg-accent hover:text-foreground",
                active && "bg-accent text-foreground"
              );
        return (
          <Link
            key={item.href}
            href={item.href}
            className={itemClass}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
