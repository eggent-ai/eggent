"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useI18n } from "@/i18n/provider";

interface ToolGroupProps {
  count: number;
  running: boolean;
  /** Tool names in call order, used for the one-line preview when collapsed. */
  names: string[];
  children: ReactNode;
}

/**
 * Collapses a run of consecutive tool calls into a single row.
 *
 * A long task can fire a dozen tools before it says anything, and rendering one
 * bordered box per call buries the actual answer under a fence. The calls stay
 * available — this only changes whether they are open by default.
 */
export function ToolGroup({ count, running, names, children }: ToolGroupProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [bumped, setBumped] = useState(false);
  const previousCount = useRef(count);

  useEffect(() => {
    if (count === previousCount.current) return;
    previousCount.current = count;
    setBumped(true);
    const timer = setTimeout(() => setBumped(false), 450);
    return () => clearTimeout(timer);
  }, [count]);

  // Enough to recognize the work without reading like a stack trace.
  const preview = Array.from(new Set(names)).slice(0, 3).join(", ");

  return (
    <div className="rounded-lg border bg-card/40">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Wrench className={`size-3.5 shrink-0 ${running ? "animate-pulse" : ""}`} />
        <span className="font-medium">{t("chat.tools.group")}</span>
        {/* The leading is pinned because an arbitrary font size resets it to
            "normal", which made this badge - the tallest thing in the row - 1.33px
            shorter than the same badge in a single tool card, and the two headers
            then sat at different heights beside the same avatar. */}
        <span
          key={count}
          className={`inline-flex min-w-5 justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px]/4 font-medium tabular-nums text-foreground ${
            bumped ? "animate-in zoom-in-50 fade-in duration-300" : ""
          }`}
        >
          {count}
        </span>
        {preview ? <span className="truncate text-muted-foreground/70">{preview}</span> : null}
        {running ? <span className="ml-auto shrink-0 text-muted-foreground/70">{t("chat.tools.running")}</span> : null}
      </button>

      {expanded ? <div className="flex flex-col gap-2 border-t px-3 py-2">{children}</div> : null}
    </div>
  );
}
