"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Brain,
  Cable,
  CalendarClock,
  Cpu,
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
import { SCOPE_PARAM, projectIdFromPath, settingsScopeHref } from "@/lib/orchestrator-scope";
import { cn } from "@/lib/utils";

const SETTINGS_SECTIONS: Array<{ href: string; labelKey: MessageKey; icon: LucideIcon; exact?: boolean }> = [
  // The address every link to Settings already uses, first run included, so
  // it keeps meaning the model. Matched exactly because General lives under it.
  { href: "/dashboard/settings", labelKey: "settings.nav.models", icon: Cpu, exact: true },
  { href: "/dashboard/projects", labelKey: "settings.nav.projects", icon: FolderOpen },
  { href: "/dashboard/context", labelKey: "settings.nav.context", icon: FileText },
  { href: "/dashboard/memory", labelKey: "settings.nav.memory", icon: Brain },
  { href: "/dashboard/skills", labelKey: "settings.nav.skills", icon: Puzzle },
  { href: "/dashboard/mcp", labelKey: "settings.nav.mcp", icon: Wrench },
  { href: "/dashboard/pipelines", labelKey: "settings.nav.pipelines", icon: GitBranch },
  { href: "/dashboard/schedules", labelKey: "settings.nav.schedules", icon: CalendarClock },
  { href: "/dashboard/messengers", labelKey: "settings.nav.messengers", icon: Send },
  { href: "/dashboard/api", labelKey: "settings.nav.api", icon: Cable },
  { href: "/dashboard/settings/general", labelKey: "settings.nav.general", icon: Settings },
];

export function SettingsNavigation() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  // The project being looked at travels with the tabs, so moving from Context
  // to Memory shows the same project's memory. Being on a project's own page
  // counts as looking at it.
  const scopeId = searchParams.get(SCOPE_PARAM) || projectIdFromPath(pathname);

  // The strip scrolls sideways when it does not fit, which with the files panel
  // open is most of the time, and every tab is a page of its own that arrives
  // scrolled to the start: the tab you are on could be past the edge. Kept in
  // view, again whenever the strip changes width. Only the strip moves - a
  // scrollIntoView would move the page as well.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const reveal = () => {
      const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const tab = active.getBoundingClientRect();
      const visible = strip.getBoundingClientRect();
      if (tab.left < visible.left) strip.scrollLeft -= visible.left - tab.left;
      else if (tab.right > visible.right) strip.scrollLeft += tab.right - visible.right;
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <nav aria-label="Settings sections" className="rounded-xl border bg-card/80 p-1.5 shadow-sm backdrop-blur">
      <div ref={stripRef} className="flex items-center gap-1 overflow-x-auto">
        {SETTINGS_SECTIONS.map(({ href, labelKey, icon: Icon, exact }) => {
          const active = exact
            ? pathname === href
            : pathname === href ||
              pathname.startsWith(`${href}/`) ||
              (href === "/dashboard/pipelines" && pathname.startsWith("/dashboard/pipeline-runs/"));
          return (
            <Link
              key={href}
              href={settingsScopeHref(href, scopeId)}
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
