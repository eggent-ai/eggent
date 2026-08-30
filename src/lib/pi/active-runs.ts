/**
 * Which chats have an agent working in them right now.
 *
 * Every surface used to start its own session and know nothing about the
 * others, so a chat could have two agents running at once with no way to reach
 * either. A user watching a long Telegram run typed "Стоп" into the web, a
 * second agent answered "stopped" — truthfully, about itself — and the first one
 * carried on working and writing for another two minutes. From where he sat the
 * stop button was simply broken, and he re-sent the whole task.
 *
 * One Next.js server per workspace, so a plain map is the whole mechanism; a
 * file would only add a way for the two to disagree.
 */

/** The subset of the runtime session this module needs. */
export interface AbortableRun {
  abort(): Promise<void>;
  steer(text: string): Promise<void>;
  readonly isStreaming: boolean;
}

interface ActiveRun {
  session: AbortableRun;
  runId: string;
  startedAt: number;
  /** Where the message that started this run came from, for the reply wording. */
  surface: "web" | "external";
}

const runs = new Map<string, ActiveRun>();

export function registerActiveRun(
  chatId: string,
  run: { session: AbortableRun; runId: string; surface: ActiveRun["surface"] }
): void {
  if (!chatId) return;
  runs.set(chatId, { ...run, startedAt: Date.now() });
}

/**
 * Drop a run, but only if it is still the one that registered.
 *
 * Two runs can overlap for a moment while the first is winding down, and a
 * blind delete in the loser's `finally` would leave the live one unreachable.
 */
export function clearActiveRun(chatId: string, runId: string): void {
  const current = runs.get(chatId);
  if (current && current.runId === runId) runs.delete(chatId);
}

export function getActiveRun(chatId: string): ActiveRun | undefined {
  const run = runs.get(chatId);
  if (!run) return undefined;
  // A session that has stopped streaming is finishing up; nothing to interrupt.
  if (!run.session.isStreaming) {
    runs.delete(chatId);
    return undefined;
  }
  return run;
}

/**
 * Words that mean "stop", recognised without asking a model.
 *
 * Matched against the whole message, not searched inside it: "stop" alone is an
 * instruction, while "stop words in the index" is a task. Deliberately a short
 * closed list — a wrong guess here throws away work in progress, so the cost of
 * missing one phrasing is much lower than the cost of inventing one.
 */
const STOP_PHRASES = new Set([
  "стоп", "стой", "стопе", "хватит", "отмена", "отмени", "прекрати", "прекратить",
  "останови", "остановись", "стоп стоп", "не надо", "отставить",
  "stop", "stop stop", "halt", "cancel", "abort", "wait", "hold on", "nevermind",
  "never mind", "enough", "quit", "stop it", "stop please",
]);

const MAX_STOP_MESSAGE_CHARS = 24;

export function isStopRequest(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .replace(/[!.,;:?—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > MAX_STOP_MESSAGE_CHARS) return false;
  return STOP_PHRASES.has(normalized);
}

/** For tests and diagnostics only. */
export function activeRunCount(): number {
  return runs.size;
}
