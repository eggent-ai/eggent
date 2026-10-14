"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { copyTextToClipboard } from "@/lib/utils";

interface UserMessageFooterProps {
  text: string;
  createdAt?: string;
}

/**
 * The line under the person's message: when it was sent and a copy button.
 * Shown on hover where there is a mouse, always on a touch screen.
 */
export function UserMessageFooter({ text, createdAt }: UserMessageFooterProps) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  // The time is drawn after mount: the server's clock and time zone are not the reader's.
  const [time, setTime] = useState<{ label: string; full: string } | null>(null);

  useEffect(() => {
    setTime(createdAt ? formatSentAt(createdAt, locale) : null);
  }, [createdAt, locale]);

  const handleCopy = async () => {
    if (!(await copyTextToClipboard(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/user:opacity-100 [@media(hover:hover)]:group-focus-within/user:opacity-100">
      {time ? (
        <time dateTime={createdAt} title={time.full} className="px-1 tabular-nums">
          {time.label}
        </time>
      ) : null}
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? t("chat.code.copied") : t("chat.code.copy")}
        title={copied ? t("chat.code.copied") : t("chat.code.copy")}
        className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function formatSentAt(iso: string, locale: string): { label: string; full: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const timeLabel = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  const label = sameDay
    ? timeLabel
    : `${date.toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      })}, ${timeLabel}`;
  const full = date.toLocaleString(locale, { dateStyle: "long", timeStyle: "short" });
  return { label, full };
}
