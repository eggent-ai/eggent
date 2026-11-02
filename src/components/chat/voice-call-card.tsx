"use client";

import { useState } from "react";
import { AudioLines, ChevronDown } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { VoiceCallRecord } from "@/lib/types";
import { formatCallLength } from "@/lib/voice/tools";

/**
 * A voice call in the chat once it is over: how long it was, and what was
 * said, folded away. The short summary the call left is the message's own
 * text, drawn under this card with the label above it.
 */
export function VoiceCallCard({ record, hasSummary }: { record: VoiceCallRecord; hasSummary: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = record.transcript ?? [];
  return (
    <div className="flex flex-col gap-2" data-voice-call-card>
      <div className="rounded-xl border bg-muted/30">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={lines.length === 0}
          aria-expanded={open}
          className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-sm disabled:cursor-default"
        >
          <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 font-medium">
            {t("voice.card.title")} <span className="text-muted-foreground tabular-nums">· {formatCallLength(record.seconds)}</span>
          </span>
          {lines.length > 0 ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {t(open ? "voice.card.hideTranscript" : "voice.card.showTranscript")}
              <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
            </span>
          ) : null}
        </button>
        {open ? (
          <ol className="flex max-h-96 flex-col gap-2 overflow-y-auto border-t px-3 py-2.5 text-sm/6">
            {lines.map((line, index) => (
              <li key={index} className="min-w-0 break-words">
                <span className="font-medium text-muted-foreground">{t(line.role === "user" ? "voice.card.you" : "voice.card.agent")}: </span>
                {line.text}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {hasSummary ? <p className="text-sm font-semibold">{t("voice.summaryHeading")}</p> : null}
    </div>
  );
}
