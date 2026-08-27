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
      ? "inline-flex gap-1 border-b border-white/[0.08]"
      : "inline-flex rounded-lg border border-white/[0.08] bg-white/[0.025] p-1";

  return (
    <div className={cn(variant === "pill" && "mt-4", wrapperClass, className)}>
      {items.map((item) => {
        const active = pathname === item.href;
        const itemClass =
          variant === "underline"
            ? cn(
                "rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground motion-fast transition hover:border-white/35 hover:text-foreground",
                active && "border-white text-foreground"
              )
            : cn(
                "rounded-md px-3 py-1.5 text-sm text-muted-foreground motion-fast transition hover:bg-white/5 hover:text-foreground",
                active && "bg-white text-[#18181a]"
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
