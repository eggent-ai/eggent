"use client";

import type { UIMessage } from "ai";
import { Clock3, Loader2, Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { readSteerDelivered, STEER_DELIVERED_PART } from "@/lib/pi/steer-shape";

/**
 * A message said to a turn while it works, before the agent has read it - or
 * one the turn ended without reading.
 *
 * It is drawn as the person's own message (the grey box on the right) but open
 * at the edges and quieter, with one line saying where it stands: it is not
 * part of the conversation yet. Once the agent reads it, it becomes an ordinary
 * message at the point in the answer where that happened.
 */

export type SteerViewState = "sending" | "queued" | "after-turn" | "undelivered";

export interface SteerView {
  messageId: string;
  text: string;
  state: SteerViewState;
}

const STATE_COPY: Record<SteerViewState, MessageKey> = {
  sending: "chat.steer.sending",
  queued: "chat.steer.queued",
  "after-turn": "chat.steer.afterTurn",
  undelivered: "chat.steer.undelivered",
};

export function SteerBubble({ view, onResend }: { view: SteerView; onResend?: (view: SteerView) => void }) {
  const { t } = useI18n();
  const undelivered = view.state === "undelivered";
  return (
    <div className="flex flex-col items-end py-2" data-message-role="user" data-steer-state={view.state}>
      <div className="max-w-[85%] min-w-0 rounded-2xl border border-dashed border-border bg-muted/50 px-4 py-2 text-sm leading-7 text-foreground/80 [overflow-wrap:anywhere]">
        <p className="whitespace-pre-wrap">{view.text}</p>
      </div>
      <div className="mt-1 flex max-w-[85%] items-center gap-1.5 px-1 text-xs text-muted-foreground" role="status">
        {view.state === "sending" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : undelivered ? (
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Clock3 className="size-3.5 shrink-0" aria-hidden />
        )}
        <span>{t(STATE_COPY[view.state])}</span>
        {undelivered && onResend ? (
          <Button type="button" variant="outline" size="sm" className="ml-1 h-7 gap-1.5 px-2.5 text-xs" onClick={() => onResend(view)}>
            <Send className="size-3" aria-hidden />
            {t("chat.steer.resend")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** What a stored or streamed message says about having been said to a turn: see ChatSteerInfo. */
export function steerStateOf(message: UIMessage): "queued" | "delivered" | "undelivered" | null {
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const steer = (metadata as { steer?: { state?: unknown } }).steer;
  const state = steer?.state;
  return state === "queued" || state === "delivered" || state === "undelivered" ? state : null;
}

export function steerRunOf(message: UIMessage): string | null {
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const runId = (metadata as { steer?: { runId?: unknown } }).steer?.runId;
  return typeof runId === "string" ? runId : null;
}

/**
 * The answer still being written, cut where the agent read a message said to
 * it: the part before, the person's words, the part after - the same shape the
 * stored chat takes once the turn is over. A helper's progress is looked up by
 * the call it belongs to, so each part keeps all of it.
 */
export function splitAtSteers(messages: UIMessage[]): UIMessage[] {
  const out: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.parts.some((part) => part.type === STEER_DELIVERED_PART)) {
      out.push(message);
      continue;
    }
    const helpers = message.parts.filter((part) => part.type === "data-piSubagent");
    let current: UIMessage["parts"] = [];
    let piece = 0;
    const flush = () => {
      if (current.length > 0) {
        out.push({ ...message, id: piece === 0 ? message.id : `${message.id}~${piece}`, parts: [...current, ...helpers] });
      }
      piece += 1;
      current = [];
    };
    for (const part of message.parts) {
      if (part.type === STEER_DELIVERED_PART) {
        const said = readSteerDelivered((part as { data?: unknown }).data);
        flush();
        if (said) {
          out.push({
            id: said.messageId,
            role: "user",
            metadata: { createdAt: said.createdAt, steer: { state: "delivered" } },
            parts: [{ type: "text", text: said.text }],
          });
        }
        continue;
      }
      if (part.type === "data-piSubagent") continue;
      current.push(part);
    }
    flush();
  }
  return out;
}
