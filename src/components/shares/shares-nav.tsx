"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { SidebarCount } from "@/components/sidebar-count";
import { useSharesSummary } from "./use-shares-summary";

/**
 * Shared files' place in the sidebar, under approvals: the number is the
 * files colleagues shared with something new since the person last opened
 * them, plus open comments on the person's own shared files. Absent without
 * sharing.
 */
export function SharesNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const summary = useSharesSummary();
  if (!summary || !summary.enabled) return null;
  const active = pathname.startsWith("/dashboard/shared");
  const news = summary.unseen + summary.openOnMine;
  const label = [
    summary.unseen > 0 ? t("nav.sharedNew", { count: summary.unseen }) : "",
    summary.openOnMine > 0 ? t("nav.sharedComments", { count: summary.openOnMine }) : "",
  ].filter(Boolean).join(", ");
  return (
    <Link
      href="/dashboard/shared"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Users aria-hidden className="size-4" />
      <span className="flex-1 truncate">{t("nav.shared")}</span>
      <SidebarCount count={news} tone="shared" label={label} />
    </Link>
  );
}
