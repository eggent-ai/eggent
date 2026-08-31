import type { UIMessage, UIMessageStreamWriter } from "ai";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

/**
 * What a run is producing right now, kept where a second reader can find it.
 *
 * A turn used to exist only inside the HTTP response that started it. Click
 * another chat, open settings, close the tab, and everything the agent had
 * written so far was gone: the run carried on server-side, but the only copy of
 * its output was being piped into a connection nobody was reading. Coming back
 * showed the opening user message and then nothing at all - for minutes, until
 * the turn ended and the finished message was persisted. From where the user
 * sat, the workspace had swallowed the request.
 *
 * So the run writes its stream here instead, and the response is just the first
 * reader. The buffer replays what has happened to whoever attaches next, then
 * follows along live, which is the same thing the tab that started it sees.
 *
 * The buffer holds no more than what is about to be persisted anyway - it is
 * the same tool outputs and the same text, and it is dropped the moment the run
 * ends, because from then on the stored chat is the better copy.
 */

/** Exactly what `writer.write` accepts, so a chunk can go to either. */
export type LiveRunChunk = Parameters<UIMessageStreamWriter<UIMessage>["write"]>[0];

export type LiveRunSurface = "web" | "external";

export interface LiveRunSummary {
  chatId: string;
  runId: string;
  startedAt: number;
  surface: LiveRunSurface;
}

/** The writing end, held by the run that owns it. */
export interface LiveRunSink {
  readonly chatId: string;
  readonly runId: string;
  push(chunk: LiveRunChunk): void;
  finish(): void;
}

interface Reader {
  onChunk: (chunk: LiveRunChunk) => void;
  onFinish: () => void;
}

interface LiveRunState {
  chatId: string;
  runId: string;
  projectId: string | null;
  surface: LiveRunSurface;
  startedAt: number;
  chunks: LiveRunChunk[];
  readers: Set<Reader>;
  /** Callers waiting for the turn to be over and written down, not watching it. */
  finishWaiters: Set<() => void>;
  finished: boolean;
}

/**
 * One process per workspace, same as the active-run registry - but unlike that
 * one this map is read from a different route than the one that fills it, and a
 * dev-mode module reload would hand the two halves separate maps. The event bus
 * hangs off the global for the same reason.
 */
const RUNS_KEY = "__EGGENT_LIVE_RUNS__";

function registry(): Map<string, LiveRunState> {
  const globalWithRuns = globalThis as typeof globalThis & {
    [RUNS_KEY]?: Map<string, LiveRunState>;
  };
  if (!globalWithRuns[RUNS_KEY]) {
    globalWithRuns[RUNS_KEY] = new Map<string, LiveRunState>();
  }
  return globalWithRuns[RUNS_KEY];
}

function isTextDelta(
  chunk: LiveRunChunk
): chunk is Extract<LiveRunChunk, { type: "text-delta" }> {
  return chunk.type === "text-delta";
}

/**
 * Append, folding consecutive deltas of one text part into a single chunk.
 *
 * A token at a time is the right size to send and the wrong size to keep: a
 * long answer is tens of thousands of objects that replay to exactly the same
 * text. Folding makes the buffer grow with the answer rather than with the
 * tokens it arrived in. The fold writes a new object rather than editing the
 * last one, because that one has already been handed to the live readers.
 */
function record(run: LiveRunState, chunk: LiveRunChunk): void {
  const last = run.chunks[run.chunks.length - 1];
  if (isTextDelta(chunk) && last && isTextDelta(last) && last.id === chunk.id) {
    run.chunks[run.chunks.length - 1] = { ...last, delta: last.delta + chunk.delta };
    return;
  }
  run.chunks.push(chunk);
}

export function startLiveRun(input: {
  chatId: string;
  runId: string;
  projectId?: string | null;
  surface: LiveRunSurface;
}): LiveRunSink {
  const runs = registry();

  // Two runs can overlap for a moment while the first winds down. The newer one
  // owns the chat from here; the older one's sink still works and still ends,
  // it just stops being what a new reader attaches to.
  const previous = runs.get(input.chatId);
  if (previous && previous.runId !== input.runId) {
    finishState(previous);
  }

  const state: LiveRunState = {
    chatId: input.chatId,
    runId: input.runId,
    projectId: input.projectId ?? null,
    surface: input.surface,
    startedAt: Date.now(),
    chunks: [],
    readers: new Set<Reader>(),
    finishWaiters: new Set<() => void>(),
    finished: false,
  };
  runs.set(input.chatId, state);

  publishUiSyncEvent({
    topic: "chat",
    chatId: state.chatId,
    projectId: state.projectId,
    reason: "run_started",
  });

  return {
    chatId: state.chatId,
    runId: state.runId,
    push(chunk) {
      if (state.finished) return;
      record(state, chunk);
      for (const reader of state.readers) {
        try {
          reader.onChunk(chunk);
        } catch {
          // A reader whose connection has gone must not stop the run.
        }
      }
    },
    finish() {
      finishState(state);
    },
  };
}

function finishState(state: LiveRunState): void {
  if (state.finished) return;
  state.finished = true;

  const runs = registry();
  if (runs.get(state.chatId) === state) runs.delete(state.chatId);

  const readers = [...state.readers];
  const waiters = [...state.finishWaiters];
  state.readers.clear();
  state.finishWaiters.clear();
  // The stored chat is the better copy from here, and it is already written.
  state.chunks = [];

  for (const reader of readers) {
    try {
      reader.onFinish();
    } catch {
      // Closing one reader must not skip the rest.
    }
  }
  for (const waiter of waiters) {
    try {
      waiter();
    } catch {
      // Same: one waiter must not swallow the others.
    }
  }

  publishUiSyncEvent({
    topic: "chat",
    chatId: state.chatId,
    projectId: state.projectId,
    reason: "run_ended",
  });
}

/**
 * Start reading a run that is already going: everything so far, then the rest.
 *
 * The replay is delivered before the reader is registered, with nothing awaited
 * in between, so a chunk arriving at that instant cannot land ahead of the
 * history it belongs after.
 *
 * Returns null when there is nothing to watch, which is the ordinary answer -
 * most chats are not running anything.
 */
export function attachToLiveRun(
  chatId: string,
  reader: Reader
): { runId: string; detach: () => void } | null {
  const state = registry().get(chatId);
  if (!state || state.finished) return null;

  for (const chunk of state.chunks) {
    reader.onChunk(chunk);
  }
  state.readers.add(reader);

  return {
    runId: state.runId,
    detach: () => {
      state.readers.delete(reader);
    },
  };
}

/**
 * Resolve once this chat's turn is over - and therefore written down.
 *
 * The run persists what it produced before it releases its readers, so anyone
 * who waits for this can read the stored chat straight afterwards and find the
 * partial turn in it. That is what a stop needs: without the wait, the person
 * who pressed it watches their half-written answer vanish and come back a
 * second later, when the file finally lands.
 *
 * Bounded, because a wedged run must not hold a request open.
 */
export function whenLiveRunFinished(chatId: string, timeoutMs = 10_000): Promise<void> {
  const state = registry().get(chatId);
  if (!state || state.finished) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.finishWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    // Never keep the process alive for this.
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    state.finishWaiters.add(done);
  });
}

export function getLiveRun(chatId: string): LiveRunSummary | null {
  const run = registry().get(chatId);
  if (!run || run.finished) return null;
  return {
    chatId: run.chatId,
    runId: run.runId,
    startedAt: run.startedAt,
    surface: run.surface,
  };
}

export function listLiveRuns(): LiveRunSummary[] {
  return [...registry().values()]
    .filter((run) => !run.finished)
    .map((run) => ({
      chatId: run.chatId,
      runId: run.runId,
      startedAt: run.startedAt,
      surface: run.surface,
    }));
}

/** For tests and diagnostics only. */
export function liveRunCount(): number {
  return registry().size;
}
