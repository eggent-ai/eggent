"use client";

import Link from "next/link";
import { AtSign } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { EmailLetterInfo, EmailReplyNotice } from "@/lib/email/types";
import { emailLetterPath } from "./paths";

function shortened(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** Over a chat opened for one letter: which letter, and how a reply goes out. */
export function EmailLetterBanner({ info }: { info: EmailLetterInfo }) {
  const { t } = useI18n();
  return (
    <div className="border-b bg-muted/40 px-4 py-2.5 md:px-6">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3 text-sm">
        <AtSign className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t("email.banner.about", { from: info.from })}</p>
          <p className="font-medium break-words">{info.subject || t("email.noSubject")}</p>
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-muted-foreground">{shortened(info.quote, 400)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("email.banner.howItWorks")}{" "}
            <Link className="font-medium text-foreground underline-offset-2 hover:underline" href={emailLetterPath(info.letterId)}>
              {t("email.banner.open")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Under an answer: replies that came to letters the agent sent from this chat.
 * Who and about what, and the way to the letter - the agent has not read it.
 */
export function EmailReplyNote({ replies }: { replies: EmailReplyNotice[] }) {
  const { t } = useI18n();
  if (!replies.length) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground" data-email-replies>
      {replies.map((reply) => (
        <div key={reply.letterId} className="flex items-start gap-2">
          <AtSign className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{t("email.reply.note", { from: reply.from, subject: reply.subject || t("email.noSubject") })}</span>
          <Link href={emailLetterPath(reply.letterId)} className="shrink-0 underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground">
            {t("email.reply.open")}
          </Link>
        </div>
      ))}
    </div>
  );
}
