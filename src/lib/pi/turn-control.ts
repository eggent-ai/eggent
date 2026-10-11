import { clearActiveRun, getActiveRun, stopActiveRun, type AbortableRun } from "@/lib/pi/active-runs";
import { abandonLiveRun, getLiveRun } from "@/lib/pi/live-run";
import { cancelPendingInteractionsForRun, listPendingInteractions } from "@/lib/pi/pending-interactions";

/**
 * Reaching a turn that will not end, and a turn that has not begun.
 *
 * A turn used to become reachable - to a stop, a reset, the sidebar's running
 * dot - only after its session was built, and building one runs extension
 * code: a server that never answers, an approval nobody can see. A turn stuck
 * there could not be stopped by anything, because as far as the registry knew
 * it did not exist. It is registered now from its first line, with a stand-in
 * for the session, and the stand-in forwards what it is asked to the session
 * once there is one.
 */

/** What stands in for a session that is still being built. */
export interface StartingRun {
  /** Registered while the session is built; stop works at once, a steer waits for the session. */
  readonly run: AbortableRun;
  /** The session exists: later calls go straight to it. */
  attach(session: Pick<AbortableRun, "steer">): void;
  /** What was said to the turn before it could hear it, handed over once. */
  takeQueuedSteers(): string[];
}

export function createStartingRun(onStop: () => void): StartingRun {
  let target: Pick<AbortableRun, "steer"> | null = null;
  const queued: string[] = [];
  return {
    run: {
      async abort() {
        onStop();
      },
      async steer(text: string) {
        if (target) await target.steer(text);
        else queued.push(text);
      },
      // A turn that is starting is going: it must not be dropped from the
      // registry as one that has stopped streaming.
      get isStreaming() {
        return true;
      },
    },
    attach(session) {
      target = session;
    },
    takeQueuedSteers() {
      return queued.splice(0, queued.length);
    },
  };
}

/** The turn was stopped before its session existed. */
export class TurnAbortedError extends Error {
  constructor() {
    super("The turn was stopped before it started.");
    this.name = "TurnAbortedError";
  }
}

/**
 * Wait for `work`, unless the signal aborts first.
 *
 * What `work` produces after that is handed to `onLate`, so a session that
 * finally got built for a turn nobody is waiting on can be thrown away rather
 * than left running.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void work.then((value) => onLate?.(value), () => undefined);
    return Promise.reject(new TurnAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new TurnAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLate?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      }
    );
  });
}

export interface ResetOutcome {
  /** Something was running in the chat. */
  found: boolean;
  /** It was waiting for an answer to a question, which is now dropped. */
  hadQuestion: boolean;
  /** A stop did not unstick it, so the chat was let go of instead. */
  abandoned: boolean;
}

async function waitUntilIdle(chatId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!getActiveRun(chatId) && !getLiveRun(chatId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !getActiveRun(chatId) && !getLiveRun(chatId);
}

/**
 * Unstick a chat: stop whatever is working in it, drop a question nobody can
 * answer, and if that does not end it within the grace, let go of it.
 *
 * Meant for a person who can see that nothing is happening. A stop asks the
 * turn to wind itself down and waits for it; a turn that is stuck is the one
 * that will not, so after the grace the chat is simply freed - the turn may
 * still be unwinding somewhere, and what it finds when it gets there is a chat
 * that has moved on.
 */
export async function resetChatTurn(chatId: string, options: { graceMs?: number } = {}): Promise<ResetOutcome> {
  const active = getActiveRun(chatId);
  const live = getLiveRun(chatId);
  if (!active && !live) return { found: false, hadQuestion: false, abandoned: false };

  const runId = active?.runId ?? live!.runId;
  const hadQuestion = listPendingInteractions(runId).some((interaction) => interaction.status === "pending");
  // A question nobody is going to answer holds the turn up for ever.
  cancelPendingInteractionsForRun(runId);
  if (active) await stopActiveRun(chatId);

  if (await waitUntilIdle(chatId, options.graceMs ?? 10_000)) return { found: true, hadQuestion, abandoned: false };

  abandonLiveRun(chatId);
  clearActiveRun(chatId, runId);
  return { found: true, hadQuestion, abandoned: true };
}
