"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Bot, ChevronDown, ChevronRight, Loader2, TriangleAlert } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { clearSummary, failSummary, usePendingSummary } from "@/lib/voice/summary-state";
import type { VoiceCallRecord } from "@/lib/types";
import { formatCallLength } from "@/lib/voice/tools";

/**
 * A voice call in the chat once it is over: how long it was, and what was
 * said, folded away. Built like the tools row (tool-group.tsx) - the same
 * frame, padding, type and badge - so it is as tall as that row and lines up
 * with the avatar the same way; the short summary the call left is the
 * message's own text, drawn under it with the label above.
 */
export function VoiceCallCard({ record, hasSummary }: { record: VoiceCallRecord; hasSummary: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = record.transcript ?? [];
  return (
    <div className="flex flex-col gap-3" data-voice-call-card>
      <div className="rounded-lg border bg-card/40">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={lines.length === 0}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          {lines.length > 0 ? (
            open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />
          ) : null}
          <AudioLines className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">{t("voice.card.title")}</span>
          {/* The same badge as the tools row's count, leading pinned, so both rows are one height. */}
          <span className="inline-flex justify-center rounded-full bg-muted px-1.5 py-0.5 text-[11px]/4 font-medium tabular-nums text-foreground">
            {formatCallLength(record.seconds)}
          </span>
          {lines.length > 0 ? (
            <span className="ml-auto shrink-0 text-muted-foreground/70">{t(open ? "voice.card.hideTranscript" : "voice.card.showTranscript")}</span>
          ) : null}
        </button>
        {open ? (
          <ol className="flex max-h-96 flex-col gap-2 overflow-y-auto border-t px-3 py-2 text-sm/6 text-foreground">
            {lines.map((line, index) => (
              <li key={index} className="min-w-0 break-words">
                <span className="font-medium text-muted-foreground">{t(line.role === "user" ? "voice.card.you" : "voice.card.agent")}: </span>
                {line.text}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {hasSummary ? <p className="font-semibold">{t("voice.summaryHeading")}</p> : null}
    </div>
  );
}

/** How long the placeholder waits for the card before it says the summary did not come. */
const SUMMARY_WAIT_MS = 60_000;

/**
 * Where a call that just ended will stand in the chat, until it does: the
 * same plate as the call card, with a spinner and "preparing the summary".
 * It gives way to the card when one more call card is in the chat than when it
 * appeared, and says the summary did not come if that takes over a minute or
 * the call could not be put into the chat. No retry: the call itself is over.
 */
export function VoiceSummaryPlaceholder({ chatId, callCards }: { chatId: string | null | undefined; callCards: number }) {
  const { t } = useI18n();
  const pending = usePendingSummary(chatId);
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    if (!pending) {
      baseline.current = null;
      return;
    }
    if (baseline.current === null) baseline.current = callCards;
    else if (callCards > baseline.current) clearSummary(pending.chatId);
  }, [pending, callCards]);

  useEffect(() => {
    if (pending?.state !== "pending") return;
    const left = SUMMARY_WAIT_MS - (Date.now() - pending.since);
    const timer = window.setTimeout(() => failSummary(pending.chatId), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [pending]);

  if (!pending) return null;
  const failed = pending.state === "failed";
  return (
    <div className="flex items-start gap-3 py-2" data-voice-summary-placeholder={pending.state}>
      <div className="mt-[5px] flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2 rounded-lg border bg-card/40 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          <AudioLines className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">{t("voice.card.title")}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {failed ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
            {t(failed ? "voice.summary.failed" : "voice.summary.preparing")}
          </span>
        </div>
      </div>
    </div>
  );
}
