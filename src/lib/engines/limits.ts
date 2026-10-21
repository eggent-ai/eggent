/**
 * How many programs run at once, and what to do once one has said its
 * subscription is used up.
 *
 * Each run is a whole program on the person's computer - a few hundred
 * megabytes and a good share of the subscription's limits - and a board, a
 * messenger or a cloud that hands several chats over at once can ask for many.
 * A few are let in at a time and the rest wait their turn, in the order they
 * asked, which the card shows. Once a program has reported that the limit is
 * reached, the next runs are told so at once instead of each starting a program
 * only to hear the same: the notice holds until the time the program gave, or
 * for a few minutes when it gave none.
 *
 * The registries live on globalThis: routes and the boot hook are compiled
 * separately, and a module-level object would be one copy per compiled module.
 */

const KEY = Symbol.for("eggent.engines.limits");

interface Waiter {
  resolve: () => void;
}

interface LimitState {
  running: number;
  queue: Waiter[];
  limitedUntil: Map<string, number>;
}

function state(): LimitState {
  const holder = globalThis as unknown as Record<symbol, LimitState | undefined>;
  return (holder[KEY] ??= { running: 0, queue: [], limitedUntil: new Map() });
}

export function maxParallelEngineRuns(): number {
  const parsed = Number(process.env.EGGENT_ENGINE_MAX_PARALLEL);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 2;
}

/** How long a limit with no stated end is believed. */
const DEFAULT_LIMIT_NOTICE_MS = 5 * 60_000;

export interface EngineSlot {
  release: () => void;
}

/**
 * A place to run in. Resolves at once when there is room, else when a run ends.
 * `onWait` is called once if the caller has to queue; a signal that fires while
 * waiting gives the place up and returns null.
 */
export async function acquireEngineSlot(signal: AbortSignal | undefined, onWait?: () => void): Promise<EngineSlot | null> {
  const current = state();
  if (signal?.aborted) return null;
  if (current.running < maxParallelEngineRuns()) {
    current.running += 1;
    return makeSlot();
  }
  onWait?.();
  const waiter: Waiter = { resolve: () => undefined };
  const turn = new Promise<void>((resolve) => {
    waiter.resolve = resolve;
  });
  current.queue.push(waiter);
  const aborted = new Promise<"aborted">((resolve) => {
    signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const outcome = await Promise.race([turn.then(() => "turn" as const), aborted]);
  if (outcome === "aborted") {
    const index = current.queue.indexOf(waiter);
    if (index >= 0) current.queue.splice(index, 1);
    else {
      // The place was handed over in the same moment the wait was given up: pass it on.
      handOver();
    }
    return null;
  }
  return makeSlot();
}

function makeSlot(): EngineSlot {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      handOver();
    },
  };
}

/** A run has ended: its place goes to whoever waited longest, else it is free. */
function handOver(): void {
  const current = state();
  const next = current.queue.shift();
  if (next) next.resolve();
  else current.running = Math.max(0, current.running - 1);
}

/** Remembers that a program's limit is reached, until `resetsAt` (unix seconds) if it said when. */
export function noteEngineLimit(engineId: string, resetsAt?: number): void {
  const until = resetsAt && resetsAt * 1000 > Date.now() ? resetsAt * 1000 : Date.now() + DEFAULT_LIMIT_NOTICE_MS;
  state().limitedUntil.set(engineId, until);
}

/** Unix milliseconds until which a program is believed to be at its limit, or null. */
export function engineLimitedUntil(engineId: string): number | null {
  const until = state().limitedUntil.get(engineId);
  if (until === undefined) return null;
  if (until <= Date.now()) {
    state().limitedUntil.delete(engineId);
    return null;
  }
  return until;
}

/** The person signed in again, or changed plan: the notice no longer holds. */
export function forgetEngineLimit(engineId: string): void {
  state().limitedUntil.delete(engineId);
}

/** For tests. */
export function resetEngineLimitsForTest(): void {
  const holder = globalThis as unknown as Record<symbol, LimitState | undefined>;
  holder[KEY] = undefined;
}
