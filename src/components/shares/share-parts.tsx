"use client";

import { useI18n } from "@/i18n/provider";
import type { ShareRole, ShareView } from "@/lib/shares/types";
import { cn } from "@/lib/utils";

/** The pieces the sharing screens are made of: a role in words, and when something happened. */

export function useRoleWords() {
  const { t } = useI18n();
  const roleWord = (role: ShareRole | "owner") => t(`shares.role.${role}`);
  /** What this person may do with a file shared with them, as a sentence. */
  const mayDo = (share: Pick<ShareView, "myRole">) => t(`shares.may.${share.myRole}`);
  return { roleWord, mayDo };
}

export function RoleBadge({ role, className }: { role: ShareRole | "owner"; className?: string }) {
  const { roleWord } = useRoleWords();
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs/4 font-medium text-foreground", role === "edit" ? "border-warning" : "border-border", className)}>
      {roleWord(role)}
    </span>
  );
}

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function useShareWhen() {
  const { locale } = useI18n();
  return (iso: string | null) => formatWhen(iso, locale);
}

/** The orchestrator's view of one of this workspace's own files, by its path under the projects folder. */
export function ownFilePath(key: string): string {
  return `/dashboard/files?${new URLSearchParams({ project: "none", path: key }).toString()}`;
}
