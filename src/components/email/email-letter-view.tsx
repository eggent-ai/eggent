"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, Download, FileText, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { chatPath } from "@/lib/dashboard-routes";
import type { EmailMessage } from "@/lib/email/types";
import { EmailBadges } from "./email-badges";
import { formatSize, formatWhen, senderName } from "./format";
import { emailFolderPath } from "./paths";
import { refreshEmailStatus } from "./use-email-status";

/**
 * One letter as it came: who sent it and what the service could check about
 * that, the text (drawn as text, never as markup), its files to download, and
 * the way to deal with it - hand it to the agent, which opens a chat where the
 * letter is material and nothing is sent until the person says so.
 */
export function EmailLetterView({ letterId }: { letterId: number }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [letter, setLetter] = useState<EmailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`/api/email/letters/${letterId}`, { cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as { letter?: EmailMessage; error?: string; code?: string };
        if (!alive) return;
        if (!response.ok || !data.letter) {
          setError(data.code === "noMessage" ? t("email.letter.missing") : data.error || t("email.loadFailed"));
          return;
        }
        setLetter(data.letter);
        void refreshEmailStatus();
      } catch {
        if (alive) setError(t("email.loadFailed"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [letterId, t]);

  const assign = async () => {
    setAssigning(true);
    setAssignError(null);
    try {
      const response = await fetch("/api/email/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ letterId }),
      });
      const data = (await response.json().catch(() => ({}))) as { chatId?: string; error?: string };
      if (!response.ok || !data.chatId) {
        setAssignError(data.error || t("email.loadFailed"));
        return;
      }
      router.push(chatPath(data.chatId));
    } catch {
      setAssignError(t("email.loadFailed"));
    } finally {
      setAssigning(false);
    }
  };

  const back = letter ? emailFolderPath(letter.direction === "out" ? "sent" : letter.folder === "other" ? "other" : "inbox") : emailFolderPath("inbox");

  return (
    <div className="flex flex-col gap-4">
      <Link href={back} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        {t("email.letter.back")}
      </Link>
      {error ? (
        <p className="text-sm text-muted-foreground" role="status">{error}</p>
      ) : !letter ? (
        <SkeletonBlock className="h-48" />
      ) : (
        <article className="flex flex-col gap-4">
          <header className="flex flex-col gap-1.5">
            <h2 className="text-xl font-semibold leading-tight break-words">{letter.subject || t("email.noSubject")}</h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="break-all text-foreground">
                {letter.direction === "out" ? t("email.to", { list: letter.to.join(", ") }) : t("email.from", { from: letter.from.name ? `${letter.from.name} <${letter.from.address ?? "?"}>` : senderName(letter) })}
              </span>
              <time dateTime={letter.at}>{formatWhen(letter.at, locale)}</time>
              <EmailBadges letter={letter} />
            </div>
            {letter.direction === "in" && letter.suspicious ? (
              <p className="flex items-start gap-2 rounded-md border border-warning px-3 py-2 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("email.letter.doubtful")}
              </p>
            ) : null}
            {letter.direction === "out" && letter.error ? (
              <p className="flex items-start gap-2 rounded-md border border-warning px-3 py-2 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("email.letter.notSent", { reason: letter.error })}
              </p>
            ) : null}
          </header>
          <div className="whitespace-pre-wrap break-words rounded-lg border px-4 py-3 text-sm leading-6">{letter.text || t("email.letter.noText")}</div>
          {letter.direction === "in" && letter.attachments.length ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t("email.letter.files")}</h3>
              <ul className="flex flex-col gap-1.5">
                {letter.attachments.map((file) => (
                  <li key={file.n} className="flex items-start gap-2 text-sm">
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <a className="inline-flex max-w-full items-center gap-1.5 font-medium underline-offset-2 hover:underline" href={`/api/email/letters/${letter.id}/files/${file.n}`}>
                        <span className="truncate">{file.name}</span>
                        <Download className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      </a>
                      <div className="text-xs text-muted-foreground">{formatSize(file.size)}</div>
                      {file.danger ? <div className="text-xs text-foreground">{t("email.letter.danger", { reason: file.danger })}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {letter.direction === "in" ? (
            <div className="flex flex-col gap-1.5">
              <div>
                <Button type="button" onClick={() => void assign()} disabled={assigning}>
                  {assigning ? <Loader2 className="animate-spin" aria-hidden /> : <Bot aria-hidden />}
                  {assigning ? t("email.letter.assigning") : t("email.letter.assign")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("email.letter.assignHelp")}</p>
              {assignError ? <p className="text-xs text-foreground" role="alert">{assignError}</p> : null}
            </div>
          ) : null}
        </article>
      )}
    </div>
  );
}
