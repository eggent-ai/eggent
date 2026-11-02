"use client";

import { useState } from "react";
import { AudioLines, ChevronDown, ChevronRight } from "lucide-react";
import { useI18n } from "@/i18n/provider";
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
