"use client";

import { cn } from "@/lib/utils";

/**
 * The number beside a sidebar row, one shape for every count in the sidebar.
 *
 * `unread` is something new for the person (filled); `attention` and `shared`
 * are things waiting on them (outlined, in the colour of what waits). 18px tall
 * so it sits inside a 32px row with even space above and below, and keyed on
 * the number so a new count arrives with a small settle rather than a jump.
 */
export function SidebarCount({
  count,
  tone = "unread",
  label,
  className,
}: {
  count: number;
  tone?: "unread" | "attention" | "shared";
  label?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      key={count}
      aria-label={label}
      title={label}
      className={cn(
        "eggent-count-in inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-[5px] text-[11px]/none font-semibold tabular-nums",
        tone === "unread" && "bg-sidebar-primary text-sidebar-primary-foreground",
        tone === "attention" && "border border-warning text-sidebar-foreground",
        tone === "shared" && "border border-info text-sidebar-foreground",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
