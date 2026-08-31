import { STOP_PHRASES } from "@/i18n/vocabulary";

/**
 * Which chats have an agent working in them right now.
 *
 * Every surface used to start its own session and know nothing about the
 * others, so a chat could have two agents running at once with no way to reach
 * either. A user watching a long Telegram run typed "stop" into the web, a
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
  /**
   * How the run wants to be stopped, when it has an opinion.
   *
   * Aborting the session alone leaves the run believing it finished normally,
   * and a turn stopped before it wrote anything then looks exactly like a turn
   * the provider never answered - which is reported as a broken provider. A run
   * that offers this hook winds itself down instead: partial output persisted,
   * pending questions cancelled, nothing diagnosed that did not happen.
   */
  requestStop?: () => void;
}

/**
 * One process per workspace - but not one module instance per process.
 *
 * A plain module-level map is not enough: routes are compiled separately, and a
 * route that only reads this registry can be handed its own empty copy of it.
 * Measured, not guessed at - on a cold server the stop endpoint saw `size = 0`
 * while a turn was demonstrably running, and every stop it was asked for was
 * answered "there is nothing running here". The event bus hangs off the global
 * for the same reason.
 */
const RUNS_KEY = "__EGGENT_ACTIVE_RUNS__";

function activeRuns(): Map<string, ActiveRun> {
  const globalWithRuns = globalThis as typeof globalThis & {
    [RUNS_KEY]?: Map<string, ActiveRun>;
  };
  if (!globalWithRuns[RUNS_KEY]) {
    globalWithRuns[RUNS_KEY] = new Map<string, ActiveRun>();
  }
  return globalWithRuns[RUNS_KEY];
}

export function registerActiveRun(
  chatId: string,
  run: {
    session: AbortableRun;
    runId: string;
    surface: ActiveRun["surface"];
    requestStop?: () => void;
  }
): void {
  if (!chatId) return;
  activeRuns().set(chatId, { ...run, startedAt: Date.now() });
}

/**
 * Drop a run, but only if it is still the one that registered.
 *
 * Two runs can overlap for a moment while the first is winding down, and a
 * blind delete in the loser's `finally` would leave the live one unreachable.
 */
export function clearActiveRun(chatId: string, runId: string): void {
  const runs = activeRuns();
  const current = runs.get(chatId);
  if (current && current.runId === runId) runs.delete(chatId);
}

export function getActiveRun(chatId: string): ActiveRun | undefined {
  const runs = activeRuns();
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
 * instruction, while "stop words in the index" is a task. The list itself is
 * vocabulary, so it lives with the other locale data — a build understands the
 * languages it ships in.
 */
const STOP_PHRASE_SET = new Set(STOP_PHRASES.map((phrase) => phrase.toLowerCase()));

const MAX_STOP_MESSAGE_CHARS = 24;

export function isStopRequest(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .replace(/[!.,;:?—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > MAX_STOP_MESSAGE_CHARS) return false;
  return STOP_PHRASE_SET.has(normalized);
}

/**
 * Stop whatever is working in this chat, on request.
 *
 * The stop button used to work by dropping the HTTP request, which is the same
 * gesture as closing the tab - so the two could never be told apart, and the
 * one that meant "I have seen enough" was indistinguishable from the one that
 * meant "I will read it later". They are separate now, and this is the first.
 */
export async function stopActiveRun(chatId: string): Promise<boolean> {
  const active = getActiveRun(chatId);
  if (!active) return false;

  if (active.requestStop) {
    active.requestStop();
  } else {
    await active.session.abort().catch((error) => {
      console.warn("Failed to stop the running turn:", error);
    });
    clearActiveRun(chatId, active.runId);
  }
  return true;
}

/** For tests and diagnostics only. */
export function activeRunCount(): number {
  return activeRuns().size;
}
