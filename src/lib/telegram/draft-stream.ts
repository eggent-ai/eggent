import type { AgentProgressEvent } from "@/lib/pi/types";

/**
 * The answer shown in a Telegram chat while it is being written.
 *
 * sendMessageDraft (Bot API 9.3, open to every bot since 9.5) puts a bubble in
 * a private chat that updates in place and disappears when the bot sends a
 * message. It is only a preview - it lives about thirty seconds - so the
 * finished answer still goes out as an ordinary message, and that is what stays
 * in the chat. Before this the person watched "typing…" for as long as the
 * whole turn took, and after twelve seconds got a separate "still working"
 * message that stayed in the chat for good.
 *
 * Until the answer starts, the draft says what is happening: "Thinking…", or a
 * line for the tool that is running. An empty draft is Telegram's own
 * "Thinking…" placeholder, and some clients draw that as a tiny bubble holding
 * nothing but the time and three dots - which is also all anyone saw for the
 * whole of a turn spent searching or reading.
 *
 * The first draft is sent without holding up the turn. If Telegram refuses it,
 * `onUnavailable` runs once and the caller shows whatever it showed before.
 */

/** What a running tool is doing, as far as the person in the chat is concerned. */
export type DraftActivity = "search" | "page" | "files" | "command" | "helper" | "service" | "image" | "send" | "work";

const TOOL_ACTIVITIES: Record<string, DraftActivity> = {
  web_search: "search",
  source_check: "search",
  web_enable: "search",
  fetch_content: "page",
  get_search_content: "page",
  read: "files",
  write: "files",
  edit: "files",
  ls: "files",
  grep: "files",
  find: "files",
  bash: "command",
  powershell: "command",
  agent: "helper",
  subagentworkflow: "helper",
  get_subagent_result: "helper",
  steer_subagent: "helper",
  mcp: "service",
  mcpscript: "service",
  eggent_generate_image: "image",
  telegram_send_message: "send",
  telegram_send_file: "send",
};

export function toolActivity(toolName: string): DraftActivity {
  return TOOL_ACTIVITIES[toolName.toLowerCase()] ?? "work";
}

export interface DraftStatus {
  /** Shown while the model works with no tool running. */
  thinking: string;
  /** The line for a running tool; nothing falls back to the tool before it, or to `thinking`. */
  tool: (toolName: string) => string | undefined;
}

export interface DraftStreamOptions {
  chatId: number | string;
  /** Calls sendMessageDraft with this body and throws on a Telegram error. */
  send: (body: Record<string, unknown>) => Promise<unknown>;
  /** Markdown to Telegram HTML, the way the finished message is rendered. */
  format: (markdown: string) => string;
  /** What the draft says until the answer starts. Without it the first draft is empty. */
  status?: DraftStatus;
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function startDraftStream(options: DraftStreamOptions): DraftStream {
  const draftId = 1 + Math.floor(Math.random() * 2_147_483_646);
  const throttleMs = options.throttleMs ?? 800;
  const refreshMs = options.refreshMs ?? 20_000;
  const base = { chat_id: options.chatId, draft_id: draftId };

  let text = "";
  // Tools running now, the latest last: the one that started last is the one
  // being waited on, and when it ends the one before it shows again.
  const running: string[] = [];
  let shownKey: string | null = null;
  let lastBody: Record<string, unknown> | null = null;
  let lastSentAt = 0;
  let pausedUntil = 0;
  let stopped = false;
  let available: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  const statusLine = (): string => {
    if (!options.status) return "";
    for (let index = running.length - 1; index >= 0; index -= 1) {
      const line = options.status.tool(running[index]);
      if (line) return line;
    }
    return options.status.thinking;
  };

  // What should be on screen now: the answer once it has started, and until
  // then the status line. Keyed, so a status and an answer that happen to read
  // the same are still told apart.
  const current = (): { key: string; plain: string; answer: boolean } | null => {
    const visible = draftTail(text);
    if (visible) return { key: `answer:${visible}`, plain: visible, answer: true };
    const line = statusLine();
    return line ? { key: `status:${line}`, plain: line, answer: false } : null;
  };
  const currentKey = () => current()?.key ?? null;

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
    const next = current();
    if (!next || next.key === shownKey) return;
    flushing = true;
    try {
      let html: string | null = null;
      try {
        // A status is ours and reads as one; the answer is the model's markdown.
        html = next.answer ? options.format(next.plain) : `<i>${escapeHtml(next.plain)}</i>`;
      } catch {
        html = null;
      }
      const sent =
        (html !== null && (await deliver({ ...base, text: html, parse_mode: "HTML" }))) ||
        // Markup Telegram cannot parse - half a code block, say - is refused;
        // the same words as plain text never are. A rate limit is not retried
        // here: the pause set by deliver() covers it.
        (!stopped && Date.now() >= pausedUntil && (await deliver({ ...base, text: next.plain })));
      if (sent) shownKey = next.key;
    } finally {
      flushing = false;
    }
    // What changed while this update was on its way goes out next.
    if (!stopped && currentKey() !== shownKey) schedule(throttleMs);
  };

  // One update at a time, refreshes included: two in flight can land in the
  // wrong order and leave older text on screen.
  const refresh = setInterval(() => {
    if (stopped || available !== true || !lastBody || flushing) return;
    if (Date.now() - lastSentAt < refreshMs) return;
    flushing = true;
    void deliver(lastBody).finally(() => {
      flushing = false;
      if (!stopped && currentKey() !== shownKey) schedule(throttleMs);
    });
  }, Math.max(250, Math.floor(refreshMs / 4)));
  refresh.unref?.();

  const opening = current();
  void deliver(
    opening
      ? { ...base, text: `<i>${escapeHtml(opening.plain)}</i>`, parse_mode: "HTML" }
      : { ...base, text: "" }
  ).then((ok) => {
    available = ok;
    if (!ok) {
      clearInterval(refresh);
      if (!stopped) options.onUnavailable?.();
      return;
    }
    shownKey = opening?.key ?? null;
    // Something may already be waiting: the turn was not held up for this call.
    if (currentKey() !== shownKey) schedule(Math.max(0, throttleMs - (Date.now() - lastSentAt)));
  });

  return {
    onProgress(event) {
      if (stopped) return;
      if (event.type === "text") {
        if (!event.delta) return;
        text += event.delta;
      } else if (event.type === "tool") {
        if (event.phase === "start") {
          running.push(event.name);
        } else {
          const index = running.lastIndexOf(event.name);
          if (index >= 0) running.splice(index, 1);
        }
        // Once the answer has started it is all the draft shows.
        if (draftTail(text)) return;
      } else {
        return;
      }
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
