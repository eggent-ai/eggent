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
  const { locale } = useI18n();
  // The time is drawn after mount: the server's clock and time zone are not the reader's.
  const [time, setTime] = useState<{ label: string; full: string } | null>(null);

  useEffect(() => {
    setTime(createdAt ? formatSentAt(createdAt, locale) : null);
  }, [createdAt, locale]);

  return (
    <div className={`mt-1 flex items-center gap-1 text-xs text-muted-foreground ${HOVER_REVEAL}`}>
      {time ? (
        <time dateTime={createdAt} title={time.full} className="px-1 tabular-nums">
          {time.label}
        </time>
      ) : null}
      <CopyMessageButton text={text} className="size-7 hover:bg-muted hover:text-foreground" />
    </div>
  );
}

// Hidden until the message is hovered or focused where there is a mouse; always shown on touch.
const HOVER_REVEAL =
  "transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/user:opacity-100 [@media(hover:hover)]:group-focus-within/user:opacity-100";

/**
 * A copy button that stays in view while a long message scrolls past: it
 * sticks to the top of the transcript inside the box, so a prompt of hundreds
 * of lines can be copied without scrolling back to either end of it.
 */
export function StickyCopyButton({ text }: { text: string }) {
  return (
    <div className="pointer-events-none sticky top-2 z-10 -mr-9 flex h-0 justify-end">
      <CopyMessageButton
        text={text}
        className={`pointer-events-auto size-7 border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground ${HOVER_REVEAL}`}
      />
    </div>
  );
}

function CopyMessageButton({ text, className }: { text: string; className: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!(await copyTextToClipboard(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const label = copied ? t("chat.code.copied") : t("chat.code.copy");
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
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
