"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { useApprovalsSummary } from "./use-approvals-summary";

/**
 * Approvals' place in the sidebar, under the board: what wants the person is a
 * version waiting for their decision, or one of theirs that came back for
 * changes, so that is the number it shows. Absent without approvals.
 */
export function ApprovalsNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const summary = useApprovalsSummary();
  if (!summary || !summary.enabled) return null;
  const active = pathname.startsWith("/dashboard/approvals");
  const needs = summary.waiting + summary.returned;
  const label = [
    summary.waiting > 0 ? t("nav.approvalsWaiting", { count: summary.waiting }) : "",
    summary.returned > 0 ? t("nav.approvalsReturned", { count: summary.returned }) : "",
  ].filter(Boolean).join(", ");
  return (
    <Link
      href="/dashboard/approvals"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <ClipboardCheck aria-hidden className="size-4" />
      <span className="flex-1 truncate">{t("nav.approvals")}</span>
      {needs > 0 ? (
        <span className="min-w-5 rounded-full border border-warning px-1.5 text-center text-xs/4 tabular-nums text-foreground" aria-label={label} title={label}>
          {needs > 99 ? "99+" : needs}
        </span>
      ) : null}
    </Link>
  );
}
