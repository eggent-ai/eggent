"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Building2, MessageSquarePlus } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { conversationIdOf, type CompanyConversationSummary } from "@/lib/company-projects/types";
import { useCompanyProjects } from "./use-company-projects";
import { companyProjectPath } from "./company-projects-nav";

/**
 * Asking a project the company opened to this person. The project and the
 * conversation live in the administrator's workspace; this screen shows them
 * and sends the question on. It reads only, so there is no model to pick, no
 * file to attach and no terminal: what the person can do is ask.
 */

interface Line {
  id: string;
  role: "user" | "assistant";
  text: string;
  failed?: boolean;
}

const MARKDOWN: Components = {
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
  li: ({ children }) => <li className="my-1">{children}</li>,
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-lg/6 font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-lg/6 font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-2 text-base/6 font-semibold">{children}</h4>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="bg-muted rounded px-1.5 py-0.5 text-sm">{children}</code>,
  pre: ({ children }) => <pre className="bg-muted my-3 overflow-x-auto rounded-md p-3 text-sm">{children}</pre>,
  blockquote: ({ children }) => <blockquote className="border-input text-muted-foreground my-3 border-l pl-4">{children}</blockquote>,
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
};

/** Read a server-sent-event answer, calling back with each event's JSON. */
async function readEvents(response: Response, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
        } catch {
          // A line that is not JSON is not an event.
        }
      }
      cut = buffer.indexOf("\n\n");
    }
  }
}

export function CompanyProjectChat({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();
  const list = useCompanyProjects();
  const project = list?.enabled ? list.projects.find((item) => item.id === projectId) : undefined;
  const missing = list !== null && (!list.enabled || !project);

  const conversation = conversationIdOf(search.get("c"));
  const [conversations, setConversations] = useState<CompanyConversationSummary[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  // The conversation an answer streaming now belongs to, so the address
  // changing under it (the first answer names a new one) does not reload it.
  const streamingInto = useRef<string | null>(null);

  const loadConversations = useCallback(async () => {
    const response = await fetch(`/api/company-projects/${encodeURIComponent(projectId)}/chats`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()) as { chats?: CompanyConversationSummary[] };
    setConversations(Array.isArray(data.chats) ? data.chats : []);
  }, [projectId]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Leaving the page stops reading the answer; the answer itself is still
  // written and stored in the project, and the next visit shows it.
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!conversation) {
      if (!streamingInto.current) setLines([]);
      return;
    }
    if (streamingInto.current === conversation) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/company-projects/${encodeURIComponent(projectId)}/chats/${conversation}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as { chat: { messages: Line[] } };
        if (!cancelled) setLines(data.chat.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })));
      })
      .catch(() => {
        if (!cancelled) setLines([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, conversation]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const openConversation = (id: string | null) => {
    if (busy) return;
    const base = companyProjectPath(projectId);
    router.replace(id ? `${base}?c=${id}` : base);
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setBusy(true);
    const answerId = `answer-${Date.now()}`;
    setLines((previous) => [...previous, { id: `ask-${Date.now()}`, role: "user", text: message }, { id: answerId, role: "assistant", text: "" }]);
    const update = (change: (line: Line) => Line) =>
      setLines((previous) => previous.map((line) => (line.id === answerId ? change(line) : line)));
    const controller = new AbortController();
    abort.current = controller;
    streamingInto.current = conversation;
    try {
      const response = await fetch(`/api/company-projects/${encodeURIComponent(projectId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...(conversation ? { conversation } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        update((line) => ({ ...line, text: data?.error || t("companyProjects.failed"), failed: true }));
        return;
      }
      const named = conversationIdOf(response.headers.get("x-eggent-conversation"));
      if (named && named !== conversation) {
        streamingInto.current = named;
        router.replace(`${companyProjectPath(projectId)}?c=${named}`);
      }
      await readEvents(response, (data) => {
        if (data.type === "text" && typeof data.delta === "string") {
          setSearching(false);
          const delta = data.delta;
          update((line) => ({ ...line, text: line.text + delta }));
        } else if (data.type === "tool") {
          setSearching(data.phase === "start");
        } else if (data.type === "done") {
          const result = data.result as { reply?: unknown } | undefined;
          const reply = typeof result?.reply === "string" ? result.reply : "";
          // The stored answer is the whole one; what streamed may stop short of it.
          if (reply) update((line) => ({ ...line, text: reply }));
        } else if (data.type === "error") {
          const payload = data.payload as { error?: unknown } | undefined;
          update((line) => ({ ...line, text: typeof payload?.error === "string" ? payload.error : t("companyProjects.failed"), failed: true }));
        }
      });
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        update((line) => ({ ...line, text: line.text || t("companyProjects.failed"), failed: !line.text }));
      }
    } finally {
      abort.current = null;
      streamingInto.current = null;
      setBusy(false);
      setSearching(false);
      void loadConversations();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  if (missing) {
    return (
      <div className="text-muted-foreground mx-auto max-w-md py-16 text-center text-sm">
        {t("companyProjects.notOpen")}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg/7 font-semibold">
            <Building2 aria-hidden className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate">{project?.title ?? " "}</span>
          </h1>
          <p className="text-muted-foreground text-sm">
            {project ? t("companyProjects.notice", { name: project.from }) : " "}
          </p>
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {conversations.length > 0 ? (
            <select
              className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-sm sm:max-w-56 sm:flex-none"
              value={conversation ?? ""}
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
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => openConversation(null)} disabled={busy || !conversation} aria-label={t("companyProjects.newConversation")}>
            <MessageSquarePlus className="size-4" />
            <span className="hidden sm:inline">{t("companyProjects.newConversation")}</span>
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4" aria-live="polite">
        {loading ? (
          <SkeletonList rows={3} />
        ) : lines.length === 0 ? (
          <div className="text-muted-foreground mx-auto max-w-md py-12 text-center text-sm">
            {project?.welcome || t("companyProjects.empty")}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {lines.map((line) =>
              line.role === "user" ? (
                <div key={line.id} className="bg-muted ml-auto max-w-[85%] rounded-2xl px-4 py-2 text-[15px]/6 whitespace-pre-wrap">
                  {line.text}
                </div>
              ) : (
                <div key={line.id} className={line.failed ? "text-destructive text-[15px]/7" : "text-[15px]/7"}>
                  {line.text ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
                      {line.text}
                    </ReactMarkdown>
                  ) : (
                    <span className="text-muted-foreground">
                      {searching ? t("companyProjects.searching") : t("companyProjects.thinking")}
                    </span>
                  )}
                </div>
              )
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <form onSubmit={send} className="mx-auto w-full max-w-3xl border-t pt-3">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("companyProjects.placeholder")}
            rows={2}
            maxLength={8000}
            className="min-h-16 resize-none pr-12 text-base md:text-[15px]"
            aria-label={t("companyProjects.placeholder")}
          />
          <Button type="submit" size="icon" className="absolute right-2 bottom-2 size-8" disabled={busy || !draft.trim()} aria-label={t("companyProjects.send")}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">{t("companyProjects.readOnly")}</p>
      </form>
    </div>
  );
}
