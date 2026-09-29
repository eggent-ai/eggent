import type { AgentProgressEvent } from "@/lib/pi/types";

/**
 * The answer shown in a Telegram chat while it is being written.
 *
 * sendMessageDraft (Bot API 9.3, open to every bot since 9.5) puts a bubble in
 * a private chat that updates in place and disappears when the bot sends a
 * message; an empty draft reads "Thinking…". It is only a preview - it lives
 * about thirty seconds - so the finished answer still goes out as an ordinary
 * message, and that is what stays in the chat. Before this the person watched
 * "typing…" for as long as the whole turn took, and after twelve seconds got a
 * separate "still working" message that stayed in the chat for good.
 *
 * The first draft is sent without holding up the turn. If Telegram refuses it,
 * `onUnavailable` runs once and the caller shows whatever it showed before.
 */

export interface DraftStreamOptions {
  chatId: number | string;
  /** Calls sendMessageDraft with this body and throws on a Telegram error. */
  send: (body: Record<string, unknown>) => Promise<unknown>;
  /** Markdown to Telegram HTML, the way the finished message is rendered. */
  format: (markdown: string) => string;
  /** Runs once if Telegram refuses drafts here, so the old indicator can take over. */
  onUnavailable?: () => void;
  /** Fewest milliseconds between two updates. */
  throttleMs?: number;
  /** How often an unchanged draft is sent again so it does not expire. */
  refreshMs?: number;
}

export interface DraftStream {
  onProgress(event: AgentProgressEvent): void;
  /**
   * Stops updating, after any update already on its way has landed: one that
   * arrived after the finished message would sit under it as a stale draft.
   */
  stop(): Promise<void>;
}

// Telegram takes 4096 characters after entities; this leaves room for the
// ellipsis and for markup the formatter adds.
const DRAFT_TEXT_LIMIT = 3800;

/** A long answer shows its latest part, the part being written. */
export function draftTail(text: string, limit = DRAFT_TEXT_LIMIT): string {
  const trimmed = text.trimStart();
  if (trimmed.length <= limit) return trimmed;
  return `…${trimmed.slice(-limit)}`;
}

function retryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/retry after (\d+)/i);
  return match ? Number(match[1]) * 1000 : null;
}

export function startDraftStream(options: DraftStreamOptions): DraftStream {
  const draftId = 1 + Math.floor(Math.random() * 2_147_483_646);
  const throttleMs = options.throttleMs ?? 800;
  const refreshMs = options.refreshMs ?? 20_000;
  const base = { chat_id: options.chatId, draft_id: draftId };

  let text = "";
  let shownText: string | null = null;
  let lastBody: Record<string, unknown> | null = null;
  let lastSentAt = 0;
  let pausedUntil = 0;
  let stopped = false;
  let available: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  const deliver = async (body: Record<string, unknown>): Promise<boolean> => {
    const attempt = options.send(body);
    inFlight = attempt.catch(() => undefined);
    try {
      await attempt;
      lastBody = body;
      lastSentAt = Date.now();
      return true;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait) pausedUntil = Date.now() + wait;
      return false;
    }
  };

  const schedule = (delay: number) => {
    if (timer || stopped || available !== true) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, Math.max(0, delay));
  };

  let flushing = false;
  const flush = async () => {
    if (stopped || flushing) return;
    const now = Date.now();
    if (now < pausedUntil) {
      schedule(pausedUntil - now);
      return;
    }
    const visible = draftTail(text);
    if (!visible || visible === shownText) return;
    flushing = true;
    try {
      let html: string | null = null;
      try {
        html = options.format(visible);
      } catch {
        html = null;
      }
      const sent =
        (html !== null && (await deliver({ ...base, text: html, parse_mode: "HTML" }))) ||
        // Markup Telegram cannot parse - half a code block, say - is refused;
        // the same words as plain text never are. A rate limit is not retried
        // here: the pause set by deliver() covers it.
        (!stopped && Date.now() >= pausedUntil && (await deliver({ ...base, text: visible })));
      if (sent) shownText = visible;
    } finally {
      flushing = false;
    }
    // Text that arrived while this update was on its way goes out next.
    if (!stopped && draftTail(text) !== shownText) schedule(throttleMs);
  };

  // One update at a time, refreshes included: two in flight can land in the
  // wrong order and leave older text on screen.
  const refresh = setInterval(() => {
    if (stopped || available !== true || !lastBody || flushing) return;
    if (Date.now() - lastSentAt < refreshMs) return;
    flushing = true;
    void deliver(lastBody).finally(() => {
      flushing = false;
      if (!stopped && draftTail(text) !== shownText) schedule(throttleMs);
    });
  }, Math.max(250, Math.floor(refreshMs / 4)));
  refresh.unref?.();

  void deliver({ ...base, text: "" }).then((ok) => {
    available = ok;
    if (!ok) {
      clearInterval(refresh);
      if (!stopped) options.onUnavailable?.();
      return;
    }
    // Text may already be waiting: the turn was not held up for this call.
    if (text) schedule(Math.max(0, throttleMs - (Date.now() - lastSentAt)));
  });

  return {
    onProgress(event) {
      if (stopped || event.type !== "text" || !event.delta) return;
      text += event.delta;
      schedule(Math.max(0, throttleMs - (Date.now() - lastSentAt)));
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearInterval(refresh);
      await inFlight;
    },
  };
}
