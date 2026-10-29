"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Paperclip } from "lucide-react";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import type { EmailSummary } from "@/lib/email/types";
import { EmailBadges } from "./email-badges";
import { formatWhen, senderName } from "./format";
import { emailFolderPath, emailLetterPath } from "./paths";
import { useEmailStatus } from "./use-email-status";

const FOLDERS = ["inbox", "other", "sent"] as const;
type Folder = (typeof FOLDERS)[number];

const FOLDER_NAME = { inbox: "email.folder.inbox", other: "email.folder.other", sent: "email.folder.sent" } as const;
const FOLDER_HELP = { inbox: "email.folderHelp.inbox", other: "email.folderHelp.other", sent: "email.folderHelp.sent" } as const;

const REFRESH_MS = 60_000;

/**
 * The agent's mailbox, one folder at a time: Inbox (the person, replies to
 * the agent's letters, people they allowed), Other (everybody else, told to
 * nobody) and Sent. Newest first; opening a letter reads it.
 */
export function EmailLettersView({ folder }: { folder: string }) {
  const { t, locale } = useI18n();
  const status = useEmailStatus();
  const current: Folder = (FOLDERS as readonly string[]).includes(folder) ? (folder as Folder) : "inbox";
  const [letters, setLetters] = useState<EmailSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/email/letters?folder=${current}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { letters?: EmailSummary[]; error?: string; code?: string };
      if (!response.ok) {
        setError(data.code === "notConfigured" ? t("email.unavailable") : data.error || t("email.loadFailed"));
        return;
      }
      setError(null);
      setLetters(Array.isArray(data.letters) ? data.letters : []);
    } catch {
      setError(t("email.loadFailed"));
    }
  }, [current, t]);

  useEffect(() => {
    setLetters(null);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const unread = status && status.enabled ? status.unread : { inbox: 0, other: 0 };

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b" aria-label={t("email.heading")}>
        {FOLDERS.map((name) => {
          const count = name === "sent" ? 0 : unread[name];
          return (
            <Link
              key={name}
              href={emailFolderPath(name)}
              aria-current={name === current ? "page" : undefined}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
                name === current ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(FOLDER_NAME[name])}
              {count > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={t("nav.messagesUnread", { count })}>
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <p className="text-xs text-muted-foreground">{t(FOLDER_HELP[current])}</p>
      {error ? (
        <p className="text-sm text-muted-foreground" role="status">{error}</p>
      ) : !letters ? (
        <SkeletonList rows={4} />
      ) : letters.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("email.empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {letters.map((letter) => {
            const unreadLetter = letter.direction === "in" && !letter.read;
            const who = letter.direction === "out" ? t("email.to", { list: letter.to.join(", ") }) : senderName(letter);
            return (
              <li key={letter.id}>
                <Link href={emailLetterPath(letter.id)} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-accent/50">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`truncate text-sm ${unreadLetter ? "font-semibold" : "font-medium"}`}>{who}</span>
                      <EmailBadges letter={letter} />
                    </div>
                    <div className={`truncate text-sm ${unreadLetter ? "text-foreground" : "text-muted-foreground"}`}>
                      {letter.subject || t("email.noSubject")}
                    </div>
                    {letter.preview ? <div className="truncate text-xs text-muted-foreground">{letter.preview}</div> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                    <time dateTime={letter.at}>{formatWhen(letter.at, locale)}</time>
                    {letter.attachments.length ? <Paperclip className="size-3.5" aria-label={t("email.letter.files")} /> : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
