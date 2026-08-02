"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Brain,
  Cable,
  CalendarClock,
  FileText,
  FolderOpen,
  GitBranch,
  Puzzle,
  Send,
  Settings,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";

const SETTINGS_SECTIONS: Array<{ href: string; labelKey: MessageKey; icon: LucideIcon }> = [
  { href: "/dashboard/settings", labelKey: "settings.nav.general", icon: Settings },
  { href: "/dashboard/projects", labelKey: "settings.nav.projects", icon: FolderOpen },
  { href: "/dashboard/context", labelKey: "settings.nav.context", icon: FileText },
  { href: "/dashboard/memory", labelKey: "settings.nav.memory", icon: Brain },
  { href: "/dashboard/skills", labelKey: "settings.nav.skills", icon: Puzzle },
  { href: "/dashboard/mcp", labelKey: "settings.nav.mcp", icon: Wrench },
  { href: "/dashboard/pipelines", labelKey: "settings.nav.pipelines", icon: GitBranch },
  { href: "/dashboard/schedules", labelKey: "settings.nav.schedules", icon: CalendarClock },
  { href: "/dashboard/messengers", labelKey: "settings.nav.messengers", icon: Send },
  { href: "/dashboard/api", labelKey: "settings.nav.api", icon: Cable },
];

export function SettingsNavigation() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav aria-label="Settings sections" className="rounded-xl border bg-card/80 p-1.5 shadow-sm backdrop-blur">
      <div className="flex items-center gap-1 overflow-x-auto">
        {SETTINGS_SECTIONS.map(({ href, labelKey, icon: Icon }) => {
          const active =
            pathname === href ||
            pathname.startsWith(`${href}/`) ||
            (href === "/dashboard/pipelines" && pathname.startsWith("/dashboard/pipeline-runs/"));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              <span>{t(labelKey)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
