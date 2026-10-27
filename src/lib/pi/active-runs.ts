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

/** A message said to a turn that is already working. */
export interface SteerRequest {
  /** What it is stored under. The screen that sent it made the id up, so its own bubble and the turn's agree. */
  messageId: string;
  /** As the person wrote it: what the chat shows. */
  text: string;
  /** What the agent reads: the same words, with any files sent beside them named. */
  modelText: string;
  createdAt: string;
  /** The chat's files sent with it, by name: a turn on the other side of a pair finds them in its own copy. */
  files?: string[];
}

/** What became of a message sent to a chat that may have a turn working in it. */
export type JoinOutcome = "stopped" | "steered" | "refused";

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
  /**
   * How the run takes a message said to it while it works, when it keeps track
   * of them itself: written down as waiting, moved to where the agent read it,
   * marked when the turn ended before the agent could. A turn relayed to the
   * other side of a pair passes it on, id and files and all, to the side that
   * keeps the record. A run without it is handed the bare words.
   */
  acceptSteer?: (request: SteerRequest) => Promise<void>;
  /**
   * This run was handed over from the other side of a workspace and computer
   * pair. Only a request that came over that road may answer its questions, and
   * only its questions - see `isRunServedForRemote`.
   */
  servedForRemote?: boolean;
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
    acceptSteer?: ActiveRun["acceptSteer"];
    servedForRemote?: boolean;
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

/**
 * Whether the run with this id is one that was handed over from the other side.
 *
 * A request that arrives over the relay may answer a question card, but only a
 * card of a turn that came the same way: the other side is trusted with the
 * chats it was allowed to hand over, not with whatever else is asking something
 * on this machine - another chat the person is working in, for one.
 */
export function isRunServedForRemote(runId: string): boolean {
  for (const run of activeRuns().values()) {
    if (run.runId === runId && run.servedForRemote === true) return true;
  }
  return false;
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

/**
 * What to do with a message that arrives while this chat already has an agent working.
 *
 * Starting a second agent was the old answer and it was the wrong one: neither
 * could see the other, so a request to stop went to a fresh session that had
 * nothing to stop, while the real run kept going. The runtime has both of the
 * primitives needed here and we were using neither.
 *
 * - A stop is honoured immediately, because that is the whole point of saying it.
 * - Anything else is steered into the running turn: it lands after the current
 *   tool calls and before the next model call, which is where a correction is
 *   still worth something. Queuing it until the end (followUp) would let the
 *   agent finish doing the thing the user was trying to redirect.
 * - A slash command is refused. The runtime cannot steer an extension command,
 *   and starting a run of its own for it put a second agent in a chat that
 *   already had one working - the very thing this registry is here to prevent.
 *   The caller says it can be sent once the turn is over.
 *
 * `steer` carries what the caller knows besides the words: the id the person's
 * screen gave the message, the words with the files sent beside them named.
 *
 * Returns null when there was no run to join, so the caller starts one normally.
 */
export async function joinActiveRun(
  chatId: string,
  message: string,
  steer: Partial<SteerRequest> = {}
): Promise<JoinOutcome | null> {
  const active = getActiveRun(chatId);
  if (!active) return null;

  if (isStopRequest(message)) {
    // Through the run's own way of stopping, when it has one: a turn aborted
    // from outside believes it finished, and one that had written nothing yet
    // was then reported as a provider that answered nothing.
    await stopActiveRun(chatId);
    return "stopped";
  }

  if (message.trimStart().startsWith("/")) return "refused";

  const request: SteerRequest = {
    messageId: steer.messageId || crypto.randomUUID(),
    text: steer.text ?? message,
    modelText: steer.modelText ?? message,
    createdAt: steer.createdAt ?? new Date().toISOString(),
    ...(steer.files?.length ? { files: steer.files } : {}),
  };
  try {
    if (active.acceptSteer) await active.acceptSteer(request);
    else await active.session.steer(request.modelText);
    return "steered";
  } catch (error) {
    // A turn that is stopping, or that ended a moment ago: the message is for a
    // turn of its own.
    console.warn("Failed to steer the running turn, starting a new one:", error);
    return null;
  }
}

/** For tests and diagnostics only. */
export function activeRunCount(): number {
  return activeRuns().size;
}
