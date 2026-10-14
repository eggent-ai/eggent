"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, CornerUpLeft, Download, FileText, Loader2, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { chatPath } from "@/lib/dashboard-routes";
import { fileDownloadUrl, filesPageUrl, isModifiedClick } from "@/lib/files/openable";
import { useAppStore } from "@/store/app-store";
import type { MailMessage, MailThreadAnswer } from "@/lib/mail/types";
import { refreshMailContacts } from "./use-mail-contacts";

/** How often an open conversation looks for what came in. */
const POLL_MS = 15_000;
const MAX_FILES = 5;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatWhen(iso: string, locale: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return sameDay(at, new Date()) ? time : `${at.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time}`;
}

function preview(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One conversation with one person: what each side wrote, signed by who wrote
 * it - the person, or their agent - and the way to answer: by hand in the box
 * below, or by handing the message to one's own agent, which opens a chat
 * about it and sends nothing until the person sends it.
 */
export function MailThreadView({ contactId }: { contactId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [thread, setThread] = useState<MailThreadAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<MailMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stickToBottom = useRef(true);
  const lastReadMarked = useRef(0);

  const markRead = useCallback(
    (messages: MailMessage[]) => {
      const newestIncoming = [...messages].reverse().find((message) => !message.fromMe);
      if (!newestIncoming || newestIncoming.id <= lastReadMarked.current) return;
      lastReadMarked.current = newestIncoming.id;
      void fetch("/api/mail/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ with: contactId }),
      }).then(() => refreshMailContacts()).catch(() => undefined);
    },
    [contactId]
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/mail/thread?with=${encodeURIComponent(contactId)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as (MailThreadAnswer & { error?: string }) | null;
      if (!response.ok || !data || !Array.isArray(data.messages)) {
        setError(data?.error || t("mail.loadFailed"));
        return;
      }
      setError(null);
      setThread((previous) => {
        if (!previous) return data;
        // Earlier pages the person already opened stay open across a refresh,
        // and a fresher copy of a message (its file copied here since) wins.
        const byId = new Map<number, MailMessage>();
        for (const message of previous.messages) byId.set(message.id, message);
        for (const message of data.messages) byId.set(message.id, message);
        const messages = [...byId.values()].sort((a, b) => a.id - b.id);
        const olderLoaded = previous.messages.length > 0 && data.messages.length > 0 && previous.messages[0].id < data.messages[0].id;
        return { ...data, messages, hasMore: olderLoaded ? previous.hasMore : data.hasMore };
      });
      if (document.visibilityState === "visible") markRead(data.messages);
    } catch {
      setError(t("mail.loadFailed"));
    }
  }, [contactId, markRead, t]);

  useEffect(() => {
    setThread(null);
    setError(null);
    setReplyTo(null);
    lastReadMarked.current = 0;
    stickToBottom.current = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const messageCount = thread?.messages.length ?? 0;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messageCount]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (!thread?.messages.length) return;
    setLoadingOlder(true);
    try {
      const before = thread.messages[0].id;
      const response = await fetch(`/api/mail/thread?with=${encodeURIComponent(contactId)}&before=${before}`, { cache: "no-store" });
      const data = (await response.json()) as MailThreadAnswer;
      if (response.ok && Array.isArray(data.messages)) {
        stickToBottom.current = false;
        setThread((previous) => previous ? { ...previous, messages: [...data.messages, ...previous.messages], hasMore: data.hasMore } : previous);
      }
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && files.length === 0) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const form = new FormData();
      form.set("to", contactId);
      form.set("text", body);
      if (replyTo) form.set("replyTo", String(replyTo.id));
      for (const file of files) form.append("files", file, file.name);
      const response = await fetch("/api/mail/send", { method: "POST", body: form });
      const data = (await response.json().catch(() => null)) as { message?: MailMessage; error?: string } | null;
      if (!response.ok || !data?.message) {
        setSendError(data?.error || t("mail.loadFailed"));
        return;
      }
      const sent = data.message;
      stickToBottom.current = true;
      setThread((previous) => previous ? { ...previous, messages: [...previous.messages, sent] } : previous);
      setText("");
      setFiles([]);
      setReplyTo(null);
      void refreshMailContacts();
      inputRef.current?.focus();
    } catch {
      setSendError(t("mail.loadFailed"));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const assign = async (message: MailMessage) => {
    setAssigning(message.id);
    try {
      const response = await fetch("/api/mail/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: message.id }),
      });
      const data = (await response.json().catch(() => null)) as { chatId?: string; error?: string } | null;
      if (!response.ok || !data?.chatId) {
        setSendError(data?.error || t("mail.loadFailed"));
        return;
      }
      if (typeof window !== "undefined") window.sessionStorage.setItem("eggent-focus-chat-input", "1");
      router.push(chatPath(data.chatId));
    } finally {
      setAssigning(null);
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((previous) => [...previous, ...Array.from(list)].slice(0, MAX_FILES));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (!thread && !error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 py-6 md:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <SkeletonList rows={4} />
        </div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>{t("mail.retry")}</Button>
      </div>
    );
  }

  const contact = thread.contact;
  const lastMine = [...thread.messages].reverse().find((message) => message.fromMe);
  const authorLabel = (message: MailMessage) => {
    if (message.fromMe) return message.author.kind === "agent" ? t("mail.message.youViaAgent") : t("mail.message.you");
    return message.author.kind === "agent" ? t("mail.message.viaAgent", { name: message.author.name }) : message.author.name;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-3 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-0.5">
          <h2 className="text-base font-semibold leading-tight">{contact.name}</h2>
          <p className="text-xs text-muted-foreground">
            {contact.role === "owner" ? t("mail.roleOwner") : contact.about ? t("mail.about", { about: contact.about }) : null}
          </p>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-4">
          {thread.hasMore ? (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("mail.loadOlder")}
              </Button>
            </div>
          ) : null}
          {thread.messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("mail.empty")}</p>
          ) : null}
          {thread.messages.map((message) => (
            <article
              key={message.id}
              className={`flex flex-col gap-1 ${message.fromMe ? "items-end" : "items-start"}`}
              aria-label={authorLabel(message)}
            >
              <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                {message.author.kind === "agent" ? <Bot className="size-3.5 self-center" aria-hidden /> : null}
                <span className="font-medium text-foreground">{authorLabel(message)}</span>
                <time dateTime={message.createdAt}>{formatWhen(message.createdAt, locale)}</time>
              </div>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-6 ${
                  message.fromMe ? "bg-primary/10" : "bg-muted"
                }`}
              >
                {message.replyTo ? (
                  <p className="mb-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                    {t("mail.message.answers", { preview: preview(message.replyTo.preview, 120) })}
                  </p>
                ) : null}
                {message.text ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : null}
                {message.attachments.length ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {message.attachments.map((file) => (
                      <li key={file.id} className="flex items-start gap-2 text-xs leading-5">
                        <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0">
                          {file.localPath ? (
                            <Link
                              className="block truncate font-medium underline-offset-2 hover:underline"
                              href={filesPageUrl("none", file.localPath)}
                              onClick={(event) => {
                                if (isModifiedClick(event) || !file.localPath) return;
                                event.preventDefault();
                                useAppStore.getState().openFilePreview("none", file.localPath);
                              }}
                            >
                              {file.name}
                            </Link>
                          ) : (
                            <a className="block truncate font-medium underline-offset-2 hover:underline" href={`/api/mail/attachments/${encodeURIComponent(file.id)}`}>
                              {file.name}
                            </a>
                          )}
                          <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                            <span>{formatSize(file.size)}</span>
                            {file.localPath ? (
                              <a className="inline-flex items-center gap-1 hover:text-foreground" href={fileDownloadUrl("none", file.localPath)}>
                                <Download className="size-3" aria-hidden />
                                {t("mail.file.download")}
                              </a>
                            ) : (
                              <span>{t("mail.file.copying")}</span>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {!message.fromMe ? (
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setReplyTo(message);
                      inputRef.current?.focus();
                    }}
                  >
                    <CornerUpLeft aria-hidden />
                    {t("mail.message.reply")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    title={t("mail.message.assignHelp")}
                    disabled={assigning !== null}
                    onClick={() => void assign(message)}
                  >
                    {assigning === message.id ? <Loader2 className="animate-spin" aria-hidden /> : <Bot aria-hidden />}
                    {assigning === message.id ? t("mail.message.assigning") : t("mail.message.assign")}
                  </Button>
                </div>
              ) : message.id === lastMine?.id && thread.contactReadUpTo >= message.id ? (
                <span className="text-xs text-muted-foreground">{t("mail.seen")}</span>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <div className="border-t px-4 py-3 md:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          {replyTo ? (
            <div className="flex items-start justify-between gap-2 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">
                {t("mail.composer.replyingTo", { name: replyTo.author.name, preview: preview(replyTo.text || replyTo.attachments.map((file) => file.name).join(", ")) })}
              </span>
              <Button variant="ghost" size="icon-xs" aria-label={t("mail.composer.cancelReply")} onClick={() => setReplyTo(null)}>
                <X aria-hidden />
              </Button>
            </div>
          ) : null}
          {files.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                  <Paperclip className="size-3 text-muted-foreground" aria-hidden />
                  <span className="max-w-48 truncate">{file.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("mail.composer.removeFile", { name: file.name })}
                    onClick={() => setFiles((previous) => previous.filter((_, at) => at !== index))}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {sendError ? <p className="text-xs text-destructive" role="alert">{sendError}</p> : null}
          <div className="flex items-end gap-2">
            <input ref={fileInputRef} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => addFiles(event.target.files)} />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("mail.composer.attach")}
              title={t("mail.composer.attach")}
              disabled={files.length >= MAX_FILES || sending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden />
            </Button>
            <Textarea
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("mail.composer.placeholder", { name: contact.name })}
              aria-label={t("mail.composer.label", { name: contact.name })}
              className="max-h-48 min-h-10 resize-none"
              rows={1}
            />
            <Button onClick={() => void send()} disabled={sending || (!text.trim() && files.length === 0)} aria-label={t("mail.composer.send")}>
              {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
              <span className="hidden sm:inline">{sending ? t("mail.composer.sending") : t("mail.composer.send")}</span>
            </Button>
          </div>
          <p className="hidden text-xs text-muted-foreground sm:block">{t("mail.composer.hint")}</p>
        </div>
      </div>
    </div>
  );
}
