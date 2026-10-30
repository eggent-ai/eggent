"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, MessageSquarePlus } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { GuestChat, type GuestChatEndpoints } from "@/components/chat/guest-chat";
import { conversationIdOf, type CompanyConversationSummary } from "@/lib/company-projects/types";
import { useCompanyProjects } from "./use-company-projects";
import { companyProjectPath } from "./company-projects-nav";

/**
 * Asking a project the company opened to this person. The project and the
 * conversation live in the administrator's workspace; this screen is the
 * workspace's own chat (GuestChat) pointed at it, with the person's
 * conversations to pick from. What the project can do there is read its files,
 * ask on a card and keep answers for the administrator; no model to pick, no
 * file to attach, no terminal.
 */
export function CompanyProjectChat({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();
  const list = useCompanyProjects();
  const project = list?.enabled ? list.projects.find((item) => item.id === projectId) : undefined;
  const missing = list !== null && (!list.enabled || !project);

  const fromAddress = conversationIdOf(search.get("c"));
  const [conversations, setConversations] = useState<CompanyConversationSummary[]>([]);
  // The conversation on screen, and a key that changes only when the person
  // opens another one: the first answer naming a new conversation changes the
  // address, and must not start the screen over under the answer being written.
  const [opened, setOpened] = useState<{ key: string; conversation: string | null }>(() => ({ key: fromAddress ?? "new", conversation: fromAddress }));
  const named = useRef<string | null>(fromAddress);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fromAddress === named.current) return;
    named.current = fromAddress;
    setOpened({ key: fromAddress ?? `new-${Date.now()}`, conversation: fromAddress });
  }, [fromAddress]);

  const base = `/api/company-projects/${encodeURIComponent(projectId)}`;
  const loadConversations = useCallback(async () => {
    const response = await fetch(`${base}/chats`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()) as { chats?: CompanyConversationSummary[] };
    setConversations(Array.isArray(data.chats) ? data.chats : []);
  }, [base]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const endpoints = useMemo<GuestChatEndpoints>(() => ({
    send: `${base}/message`,
    history: (conversation) => `${base}/chats/${encodeURIComponent(conversation)}`,
    resume: (conversation) => `${base}/chats/${encodeURIComponent(conversation)}/stream`,
    stop: `${base}/stop`,
    answer: `${base}/answer`,
  }), [base]);

  const openConversation = (id: string | null) => {
    if (busy) return;
    router.replace(id ? `${companyProjectPath(projectId)}?c=${id}` : companyProjectPath(projectId));
    if (!id) {
      // Already on a new conversation's address: start one over all the same.
      named.current = null;
      setOpened({ key: `new-${Date.now()}`, conversation: null });
    }
  };

  if (missing) {
    return (
      <div className="text-muted-foreground mx-auto max-w-md py-16 text-center text-sm">
        {t("companyProjects.notOpen")}
      </div>
    );
  }

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 pt-4 pb-3 md:px-6">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-lg/7 font-semibold">
          <Building2 aria-hidden className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{project?.title ?? " "}</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          {project ? t("companyProjects.notice", { name: project.from }) : " "}
        </p>
      </div>
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        {conversations.length > 0 ? (
          <select
            className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm sm:max-w-56 sm:flex-none"
            value={opened.conversation ?? ""}
            onChange={(event) => openConversation(event.target.value || null)}
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
        <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => openConversation(null)} disabled={busy || !opened.conversation} aria-label={t("companyProjects.newConversation")}>
          <MessageSquarePlus className="size-4" />
          <span className="hidden sm:inline">{t("companyProjects.newConversation")}</span>
        </Button>
      </div>
    </div>
  );

  return (
    <GuestChat
      key={`${projectId}:${opened.key}`}
      endpoints={endpoints}
      conversation={opened.conversation}
      onConversation={(id) => {
        named.current = id;
        setOpened((current) => ({ ...current, conversation: id }));
        router.replace(`${companyProjectPath(projectId)}?c=${id}`);
      }}
      onBusyChange={setBusy}
      onSettled={() => void loadConversations()}
      empty={{ title: project?.title ?? t("companyProjects.pageTitle"), description: project?.welcome || t("companyProjects.empty") }}
      note={t("companyProjects.readOnly")}
      header={header}
    />
  );
}
