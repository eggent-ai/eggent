"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Loader2, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import type { ProducedGroup } from "@/lib/files/produced-shape";
import type { MailReplyInfo } from "@/lib/mail/types";
import { mailThreadPath } from "./mail-nav";
import { refreshMailContacts } from "./use-mail-contacts";

/**
 * A chat opened to answer a colleague's message ("Hand to the agent"): the
 * banner that says which message, and the button under each of the agent's
 * answers that sends it. Nothing reaches the colleague until the person
 * presses Send - the agent's first answer may well be a question to them.
 */

const MailReplyContext = createContext<MailReplyInfo | null>(null);

export function MailReplyProvider({ value, children }: { value: MailReplyInfo | null; children: ReactNode }) {
  return <MailReplyContext.Provider value={value}>{children}</MailReplyContext.Provider>;
}

export function useMailReply(): MailReplyInfo | null {
  return useContext(MailReplyContext);
}

function shortened(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

export function MailReplyBanner({ info }: { info: MailReplyInfo }) {
  const { t } = useI18n();
  return (
    <div className="border-b bg-muted/40 px-4 py-2.5 md:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3 text-sm">
        <Mail className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t("mail.banner.answering", { name: info.contactName })}</p>
          <p className="line-clamp-3 whitespace-pre-wrap break-words">{shortened(info.quote, 600) || (info.files || []).join(", ")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("mail.banner.howItWorks", { name: info.contactName })}{" "}
            <Link className="font-medium text-foreground underline-offset-2 hover:underline" href={mailThreadPath(info.contactId)}>
              {t("mail.banner.openThread")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Sent from this tab already: an answer is not offered to send twice. */
const sentAnswers = new Set<string>();

/**
 * "Send to Ann", under one answer: the answer's text, which the person may
 * change, and the files the answer made, sent as written by the agent.
 */
export function SendToContact({ info, answerKey, text, produced }: { info: MailReplyInfo; answerKey: string; text: string; produced: ProducedGroup[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const [withFiles, setWithFiles] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(() => sentAnswers.has(answerKey));
  const files = produced.flatMap((group) => group.items.map((item) => ({ project: group.project, path: item.path })));

  if (sent) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Check className="size-3.5" aria-hidden />
        {t("mail.sendTo.sent", { name: info.contactName })}
      </p>
    );
  }

  if (!open) {
    return (
      <div>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setDraft(text);
            setOpen(true);
          }}
        >
          <Send aria-hidden />
          {t("mail.sendTo", { name: info.contactName })}
        </Button>
      </div>
    );
  }

  const submit = async () => {
    const body = draft.trim();
    const attach = withFiles ? files.slice(0, 5) : [];
    if (!body && attach.length === 0) {
      setError(t("mail.sendTo.empty"));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: info.contactId, text: body, replyTo: info.messageId, author: "agent", files: attach }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(t("mail.sendTo.failed", { error: data?.error || String(response.status) }));
        return;
      }
      sentAnswers.add(answerKey);
      setSent(true);
      void refreshMailContacts();
    } catch {
      setError(t("mail.sendTo.failed", { error: "network" }));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{t("mail.sendTo.preview", { name: info.contactName })}</p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={t("mail.sendTo", { name: info.contactName })}
        className="max-h-72 min-h-20 text-sm"
      />
      {files.length ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={withFiles} onChange={(event) => setWithFiles(event.target.checked)} />
          {t("mail.sendTo.files")} ({files.slice(0, 5).map((file) => file.path.split("/").pop()).join(", ")})
        </label>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={sending}>
          {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          {sending ? t("mail.sendTo.sending") : t("mail.sendTo.confirm")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
          {t("mail.sendTo.cancel")}
        </Button>
      </div>
    </div>
  );
}
