"use client";

import Link from "next/link";
import { Brain, FileText, Puzzle, Wrench, type LucideIcon } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { ORCHESTRATOR_SCOPE_ID, settingsScopeHref } from "@/lib/orchestrator-scope";

/**
 * The orchestrator's own four files, as a way in from the projects list.
 *
 * Each opens the settings tab it belongs to with the orchestrator already
 * selected - the same tabs a project's files open in. The scope is named
 * explicitly because a tab opened without one follows the project the chat is
 * in, and from here that would be the wrong one.
 */
const ORCHESTRATOR_FILES: Array<{ href: string; label: string; labelKey: MessageKey; icon: LucideIcon }> = [
  { href: "/dashboard/context", label: "context.md", labelKey: "settings.nav.context", icon: FileText },
  { href: "/dashboard/memory", label: "memory.md", labelKey: "settings.nav.memory", icon: Brain },
  { href: "/dashboard/skills", label: "skills/", labelKey: "settings.nav.skills", icon: Puzzle },
  { href: "/dashboard/mcp", label: ".mcp.json", labelKey: "settings.nav.mcp", icon: Wrench },
];

export function OrchestratorFilesNavigation() {
  const { t } = useI18n();

  return (
    <nav aria-label={t("orchestrator.title")} className="flex flex-wrap items-center gap-2">
      {ORCHESTRATOR_FILES.map(({ href, label, labelKey, icon: Icon }) => (
        <Link
          key={href}
          href={settingsScopeHref(href, ORCHESTRATOR_SCOPE_ID)}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon className="size-4" />
          <span className="font-medium">{t(labelKey)}</span>
          <span className="font-mono text-xs text-muted-foreground">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
