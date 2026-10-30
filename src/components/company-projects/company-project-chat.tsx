"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2 } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { GuestChat, type GuestChatEndpoints } from "@/components/chat/guest-chat";
import { GuestConversationsBar } from "@/components/chat/guest-conversations";
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
    <GuestConversationsBar
      icon={<Building2 />}
      title={project?.title ?? ""}
      notice={project ? t("companyProjects.notice", { name: project.from }) : null}
      conversations={conversations}
      current={opened.conversation}
      busy={busy}
      onOpen={openConversation}
    />
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
      empty={{ title: project?.title ?? t("companyProjects.pageTitle"), description: t("companyProjects.empty") }}
      welcome={project?.welcome}
      note={t("companyProjects.readOnly")}
      header={header}
    />
  );
}
