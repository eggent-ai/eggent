"use client";

import type { ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";

/**
 * The top of a guest's chat: whose project it is, what it can do, and the
 * guest's own conversations with "New conversation" - the same on a public
 * link and on a project of the company.
 */
export function GuestConversationsBar({
  icon,
  title,
  notice,
  conversations,
  current,
  busy,
  onOpen,
  extra,
}: {
  icon: ReactNode;
  title: string;
  notice?: ReactNode;
  conversations: Array<{ id: string; title: string }>;
  current: string | null;
  busy: boolean;
  onOpen: (conversation: string | null) => void;
  /** Beside the switcher: who is writing, say. */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 pt-4 pb-3 md:px-6">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-lg/7 font-semibold">
          <span aria-hidden className="text-muted-foreground shrink-0 [&_svg]:size-4">{icon}</span>
          <span className="truncate">{title || " "}</span>
        </h1>
        {notice ? <div className="text-muted-foreground text-sm">{notice}</div> : null}
      </div>
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
        {extra}
        {conversations.length > 0 ? (
          <select
            className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm sm:max-w-56 sm:flex-none"
            value={current ?? ""}
            onChange={(event) => onOpen(event.target.value || null)}
            disabled={busy}
            aria-label={t("companyProjects.conversations")}
          >
            <option value="">{t("companyProjects.newConversation")}</option>
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || t("companyProjects.untitled")}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => onOpen(null)}
          disabled={busy || !current}
          aria-label={t("companyProjects.newConversation")}
        >
          <MessageSquarePlus className="size-4" />
          <span className="hidden sm:inline">{t("companyProjects.newConversation")}</span>
        </Button>
      </div>
    </div>
  );
}
