"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Brain,
  Cable,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileText,
  FolderOpen,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const SETTINGS_SECTIONS: Array<{ href: string; labelKey: MessageKey; icon: LucideIcon; exact?: boolean }> = [
  // Existing addresses and matching rules also serve deep project/skill pages.
  { href: "/dashboard/settings", labelKey: "settings.nav.models", icon: Cpu, exact: true },
  { href: "/dashboard/projects", labelKey: "settings.nav.projects", icon: FolderOpen },
  { href: "/dashboard/context", labelKey: "settings.nav.context", icon: FileText },
  { href: "/dashboard/memory", labelKey: "settings.nav.memory", icon: Brain },
  { href: "/dashboard/skills", labelKey: "settings.nav.skills", icon: Puzzle },
  { href: "/dashboard/mcp", labelKey: "settings.nav.mcp", icon: Wrench },
  { href: "/dashboard/schedules", labelKey: "settings.nav.schedules", icon: CalendarClock },
  { href: "/dashboard/messengers", labelKey: "settings.nav.messengers", icon: Send },
  { href: "/dashboard/api", labelKey: "settings.nav.api", icon: Cable },
  { href: "/dashboard/settings/general", labelKey: "settings.nav.general", icon: Settings },
];

export function SettingsNavigation() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useI18n();
  const scopeId = searchParams.get(SCOPE_PARAM) || projectIdFromPath(pathname);
  const activeHref = SETTINGS_SECTIONS.find(({ href, exact }) => exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`))?.href;
  const navRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLButtonElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const strip = stripRef.current;
    const nav = navRef.current;
    if (!strip || !nav) return;
    const updateEdges = () => {
      const left = strip.scrollLeft > 1;
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      setEdges((previous) => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const reveal = () => {
      // CSS chooses the layout from the settings container's available width.
      // Only the mobile strip scrolls; revealing a link never moves the page.
      if (strip.clientWidth && getComputedStyle(strip).flexDirection === "row") {
        const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
        if (active) {
          const tab = active.getBoundingClientRect();
          const visible = strip.getBoundingClientRect();
          if (tab.left < visible.left + 44 || tab.right > visible.right - 44) {
            strip.scrollLeft += tab.left - visible.left - (visible.width - tab.width) / 2;
          }
        }
      }
      if (!switcherRef.current?.getClientRects().length) setSwitcherOpen(false);
      updateEdges();
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    observer.observe(nav);
    strip.addEventListener("scroll", updateEdges, { passive: true });
    reveal();
    return () => {
      observer.disconnect();
      strip.removeEventListener("scroll", updateEdges);
    };
  }, [pathname]);

  const scroll = (direction: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({
      left: direction * strip.clientWidth * 0.7,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  return (
    <nav ref={navRef} aria-label={t("nav.settings")} data-slot="settings-navigation">
      <p className="settings-nav-caption">{t("nav.settings")}</p>
      <div className="settings-nav-switcher">
        <Select value={activeHref} open={switcherOpen} onOpenChange={setSwitcherOpen}
          onValueChange={(href) => router.push(settingsScopeHref(href, scopeId))}>
          <SelectTrigger ref={switcherRef} aria-label={t("nav.settings")} className="w-full bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start" className="max-h-80 w-[var(--radix-select-trigger-width)]">
            {SETTINGS_SECTIONS.map(({ href, labelKey, icon: Icon }) => (
              <SelectItem key={href} value={href} textValue={t(labelKey)} className="min-h-10">
                <Icon className="size-4" aria-hidden="true" />
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="settings-nav-links">
        <div ref={stripRef} className="settings-nav-strip">
          {SETTINGS_SECTIONS.map(({ href, labelKey, icon: Icon }) => (
            <Link key={href} href={settingsScopeHref(href, scopeId)}
              aria-current={activeHref === href ? "page" : undefined}
              className={cn("settings-nav-link", activeHref === href && "settings-nav-link-active")}>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span>{t(labelKey)}</span>
            </Link>
          ))}
        </div>
        {edges.left ? (
          <div className="settings-nav-edge settings-nav-edge-left">
            <button type="button" onClick={() => scroll(-1)} aria-label={t("settings.nav.previous")}
              className="settings-nav-scroll"><ChevronLeft className="size-4" aria-hidden="true" /></button>
          </div>
        ) : null}
        {edges.right ? (
          <div className="settings-nav-edge settings-nav-edge-right">
            <button type="button" onClick={() => scroll(1)} aria-label={t("settings.nav.next")}
              className="settings-nav-scroll"><ChevronRight className="size-4" aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
