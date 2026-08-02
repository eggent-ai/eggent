"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brain, FileText, Puzzle, Wrench, type LucideIcon } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";

/**
 * The orchestrator's own four files, in the same order a project shows them.
 * Skills and MCP live on the shared pages, which default to this scope.
 */
const ORCHESTRATOR_FILES: Array<{ href: string; label: string; labelKey: MessageKey; icon: LucideIcon }> = [
  { href: "/dashboard/context", label: "context.md", labelKey: "settings.nav.context", icon: FileText },
  { href: "/dashboard/memory", label: "memory.md", labelKey: "settings.nav.memory", icon: Brain },
  { href: "/dashboard/skills", label: "skills/", labelKey: "settings.nav.skills", icon: Puzzle },
  { href: "/dashboard/mcp", label: ".mcp.json", labelKey: "settings.nav.mcp", icon: Wrench },
];

export function OrchestratorFilesNavigation() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav aria-label={t("orchestrator.title")} className="flex flex-wrap items-center gap-2">
      {ORCHESTRATOR_FILES.map(({ href, label, labelKey, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
              active
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            <span className="font-medium">{t(labelKey)}</span>
            <span className="font-mono text-xs text-muted-foreground">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
