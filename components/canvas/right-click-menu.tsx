"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

export type CascadingMenuEntry =
  | {
      id: string;
      kind: "action";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      id: string;
      kind: "submenu";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      items: CascadingMenuEntry[];
    }
  | {
      id: string;
      kind: "separator";
    };

interface RightClickMenuProps {
  x: number;
  y: number;
  items: CascadingMenuEntry[];
  onClose: () => void;
}

function findNextSelectableIndex(items: CascadingMenuEntry[], start: number, direction: 1 | -1) {
  if (items.length === 0) return -1;
  let index = start;
  for (let step = 0; step < items.length; step += 1) {
    const candidate = items[index];
    if (candidate && candidate.kind !== "separator" && !candidate.disabled) {
      return index;
    }
    index = (index + direction + items.length) % items.length;
  }
  return -1;
}

function buildColumns(rootItems: CascadingMenuEntry[], openPath: number[]) {
  const columns: CascadingMenuEntry[][] = [rootItems];
  let currentItems = rootItems;

  for (let depth = 0; depth < openPath.length; depth += 1) {
    const index = openPath[depth];
    const entry = currentItems[index];
    if (!entry || entry.kind !== "submenu" || entry.disabled) {
      break;
    }
    columns.push(entry.items);
    currentItems = entry.items;
  }

  return columns;
}

function RightClickMenuImpl({ x, y, items, onClose }: RightClickMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openPath, setOpenPath] = useState<number[]>([]);
  const [activePath, setActivePath] = useState<number[]>([]);
  const [resolvedPosition, setResolvedPosition] = useState({ x, y });

  const columns = useMemo(() => buildColumns(items, openPath), [items, openPath]);

  useEffect(() => {
    setResolvedPosition({ x, y });
  }, [x, y]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const parent = root.offsetParent as HTMLElement | null;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    const menuWidth = root.offsetWidth;
    const menuHeight = root.offsetHeight;
    const padding = 8;

    const clampedX = Math.min(Math.max(padding, x), Math.max(padding, parentRect.width - menuWidth - padding));
    const clampedY = Math.min(Math.max(padding, y), Math.max(padding, parentRect.height - menuHeight - padding));

    if (clampedX === resolvedPosition.x && clampedY === resolvedPosition.y) return;
    setResolvedPosition({ x: clampedX, y: clampedY });
  }, [columns.length, resolvedPosition.x, resolvedPosition.y, x, y]);

  useEffect(() => {
    const first = findNextSelectableIndex(items, 0, 1);
    if (first >= 0) {
      setActivePath([first]);
    } else {
      setActivePath([]);
    }
    setOpenPath([]);
  }, [items]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      const activeDepth = Math.max(0, columns.length - 1);
      const currentItems = columns[activeDepth] ?? [];
      const currentIndex = activePath[activeDepth] ?? findNextSelectableIndex(currentItems, 0, 1);
      if (currentIndex < 0) return;
      const currentEntry = currentItems[currentIndex];

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction: 1 | -1 = event.key === "ArrowDown" ? 1 : -1;
        const start = (currentIndex + direction + currentItems.length) % currentItems.length;
        const nextIndex = findNextSelectableIndex(currentItems, start, direction);
        if (nextIndex < 0) return;
        setActivePath((prev) => {
          const next = prev.slice(0, activeDepth + 1);
          next[activeDepth] = nextIndex;
          return next;
        });
        setOpenPath((prev) => prev.slice(0, activeDepth));
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (activeDepth === 0) return;
        setOpenPath((prev) => prev.slice(0, activeDepth - 1));
        setActivePath((prev) => prev.slice(0, activeDepth));
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (!currentEntry || currentEntry.kind !== "submenu" || currentEntry.disabled) return;
        const childItems = currentEntry.items;
        const childFirst = findNextSelectableIndex(childItems, 0, 1);
        setOpenPath((prev) => {
          const next = prev.slice(0, activeDepth);
          next[activeDepth] = currentIndex;
          return next;
        });
        if (childFirst >= 0) {
          setActivePath((prev) => {
            const next = prev.slice(0, activeDepth + 2);
            next[activeDepth + 1] = childFirst;
            return next;
          });
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (!currentEntry || currentEntry.kind === "separator" || currentEntry.disabled) return;
        if (currentEntry.kind === "action") {
          currentEntry.onSelect();
          onClose();
          return;
        }
        if (currentEntry.kind === "submenu") {
          const childFirst = findNextSelectableIndex(currentEntry.items, 0, 1);
          setOpenPath((prev) => {
            const next = prev.slice(0, activeDepth);
            next[activeDepth] = currentIndex;
            return next;
          });
          if (childFirst >= 0) {
            setActivePath((prev) => {
              const next = prev.slice(0, activeDepth + 2);
              next[activeDepth + 1] = childFirst;
              return next;
            });
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, columns, onClose]);

  return (
    <div ref={rootRef} className="absolute z-40" style={{ left: resolvedPosition.x, top: resolvedPosition.y }}>
      <div className="flex items-start gap-1">
        {columns.map((columnItems, depth) => (
          <div
            key={`menu-column-${depth}`}
            className="min-w-[218px] rounded-md border border-[#34363d] bg-[#1b1d23] p-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.45)]"
          >
            {columnItems.map((entry, index) => {
              if (entry.kind === "separator") {
                return <div key={entry.id} className="my-1 border-t border-[#2b2b2f]" />;
              }

              const isActive = activePath[depth] === index;
              const baseClass = isActive
                ? "border-cyan-400/50 bg-cyan-400/10 text-zinc-100"
                : "border-transparent bg-transparent text-zinc-200 hover:border-[#2f2f2f] hover:bg-[#181a20]";
              const disabledClass = entry.disabled ? "opacity-45 cursor-not-allowed" : "";

              return (
                <button
                  key={entry.id}
                  type="button"
                  disabled={entry.disabled}
                  className={`flex h-7 w-full items-center justify-between rounded px-2 text-left text-[13px] leading-none transition ${baseClass} ${disabledClass}`}
                  onMouseEnter={() => {
                    setActivePath((prev) => {
                      const next = prev.slice(0, depth + 1);
                      next[depth] = index;
                      return next;
                    });
                    if (entry.kind === "submenu" && !entry.disabled) {
                      setOpenPath((prev) => {
                        const next = prev.slice(0, depth);
                        next[depth] = index;
                        return next;
                      });
                    } else {
                      setOpenPath((prev) => prev.slice(0, depth));
                    }
                  }}
                  onClick={() => {
                    if (entry.disabled) return;
                    if (entry.kind === "action") {
                      entry.onSelect();
                      onClose();
                      return;
                    }
                    setOpenPath((prev) => {
                      const next = prev.slice(0, depth);
                      next[depth] = index;
                      return next;
                    });
                    const first = findNextSelectableIndex(entry.items, 0, 1);
                    if (first >= 0) {
                      setActivePath((prev) => {
                        const next = prev.slice(0, depth + 2);
                        next[depth + 1] = first;
                        return next;
                      });
                    }
                  }}
                >
                  <span className="truncate">{entry.label}</span>
                  <span className="ml-3 inline-flex shrink-0 items-center gap-1 text-[11px] text-zinc-500">
                    {entry.shortcut ? <span>{entry.shortcut}</span> : null}
                    {entry.kind === "submenu" ? <ChevronRight className="h-3.5 w-3.5 text-cyan-300" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export const RightClickMenu = memo(RightClickMenuImpl);
