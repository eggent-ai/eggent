"use client";

/**
 * Commands somebody ran from the chat, and what they printed.
 *
 * Two things in the conversation start one: the Run button under a code block
 * in an answer, and a message that begins with `!`. Both end in the same card,
 * so both live here.
 *
 * The state is a store of its own rather than local to the component that
 * showed it because the component does not last: the history sync replaces the
 * chat's messages, switching to another chat unmounts the screen, and none of
 * that should lose a build that is half way through. The process lives on the
 * server and its output is followed from here, from a module-level reader that
 * outlasts any screen; a card that mounts later simply finds the run already
 * there.
 *
 * It is kept for the length of the tab (`sessionStorage`) so a reload does not
 * drop it either, and not longer: what a command printed may be anything, a
 * file's contents included, and it should go away with the tab instead of
 * lingering in the browser's long-term storage.
 */
import { create } from "zustand";
import {
  createTerminalJob,
  followTerminalJob,
  sendTerminalInput,
  stopTerminalJob,
  type Follower,
} from "@/lib/terminal/client";
import type { TerminalCloseReason } from "@/lib/terminal/protocol";

export type ShellRunStatus = "starting" | "running" | "done" | "failed" | "stopped" | "lost" | "error";

export interface ShellRun {
  key: string;
  jobId: string | null;
  command: string;
  projectId: string | null;
  cwd: string;
  status: ShellRunStatus;
  exitCode: number | null;
  reason: TerminalCloseReason | null;
  /** The tail of what was printed; escape sequences and carriage returns still in. */
  output: string;
  /** Characters dropped from the start to keep this bounded. */
  droppedChars: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  connection: "connected" | "reconnecting";
}

/** A command typed behind `!`, and where in the conversation it was typed. */
export interface ShellCard {
  key: string;
  /** The message it follows; null when it was typed into a conversation with none. */
  anchorId: string | null;
  createdAt: number;
}

interface ShellRunsState {
  runs: Record<string, ShellRun>;
  cards: Record<string, ShellCard[]>;
  start: (input: { key: string; command: string; projectId: string | null; cwd?: string }) => Promise<void>;
  stop: (key: string) => Promise<void>;
  sendInput: (key: string, text: string) => Promise<void>;
  /** Follow a run that was started before this page was loaded, if it is still going. */
  resume: (key: string) => void;
  dismiss: (key: string) => void;
  addCard: (input: { chatId: string; anchorId: string | null; command: string; projectId: string | null; cwd?: string }) => string;
  dismissCard: (chatId: string, key: string) => void;
}

const MEMORY_CHARS = 300_000;
const STORED_OUTPUT_CHARS = 24_000;
const MAX_STORED_RUNS = 40;
const STORAGE_KEY = "eggent.shellRuns.v1";
const FLUSH_MS = 80;

type Stored = { runs: ShellRun[]; cards: Record<string, ShellCard[]> };

function readStored(): Stored | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || !Array.isArray(parsed.runs)) return null;
    return parsed;
  } catch {
    // Blocked storage, or a value that is not ours: start empty.
    return null;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (typeof window === "undefined" || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { runs, cards } = useShellRuns.getState();
    const kept = Object.values(runs)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_STORED_RUNS)
      .map((run) => ({
        ...run,
        // A run that is still going is followed again from its start, so only
        // finished ones need their output kept here.
        output: run.status === "running" || run.status === "starting" ? "" : run.output.slice(-STORED_OUTPUT_CHARS),
      }));
    const liveKeys = new Set(kept.map((run) => run.key));
    const keptCards: Record<string, ShellCard[]> = {};
    for (const [chatId, list] of Object.entries(cards)) {
      const present = list.filter((card) => liveKeys.has(card.key));
      if (present.length) keptCards[chatId] = present;
    }
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ runs: kept, cards: keptCards } satisfies Stored));
    } catch {
      // Over quota or blocked: the cards still work for as long as the page does.
    }
  }, 250);
}

const followers = new Map<string, Follower>();
const pendingOutput = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushOutput(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingOutput.size === 0) return;
  const batch = new Map(pendingOutput);
  pendingOutput.clear();
  useShellRuns.setState((state) => {
    const runs = { ...state.runs };
    for (const [key, text] of batch) {
      const run = runs[key];
      if (!run) continue;
      let output = run.output + text;
      let droppedChars = run.droppedChars;
      if (output.length > MEMORY_CHARS) {
        droppedChars += output.length - MEMORY_CHARS;
        output = output.slice(output.length - MEMORY_CHARS);
      }
      runs[key] = { ...run, output, droppedChars };
    }
    return { runs };
  });
}

function queueOutput(key: string, text: string): void {
  pendingOutput.set(key, (pendingOutput.get(key) ?? "") + text);
  if (!flushTimer) flushTimer = setTimeout(flushOutput, FLUSH_MS);
}

function patch(key: string, changes: Partial<ShellRun>): void {
  useShellRuns.setState((state) => {
    const run = state.runs[key];
    return run ? { runs: { ...state.runs, [key]: { ...run, ...changes } } } : state;
  });
  schedulePersist();
}

function statusFor(info: { code: number | null; reason: TerminalCloseReason }): ShellRunStatus {
  if (info.reason === "stopped") return "stopped";
  if (info.reason === "error") return "error";
  if (info.reason === "shutdown") return "lost";
  return info.code === 0 ? "done" : "failed";
}

function follow(key: string, jobId: string): void {
  followers.get(key)?.stop();
  // From the start every time: what is in memory is a tail, and the server
  // keeps the whole of it, so one replay is simpler than stitching the two.
  patch(key, { output: "", droppedChars: 0, connection: "connected" });
  const follower = followTerminalJob(jobId, 0, {
    onStart: ({ truncated }) => {
      if (truncated) patch(key, { droppedChars: 1 });
    },
    onOutput: (text) => queueOutput(key, text),
    onExit: (info) => {
      flushOutput();
      followers.delete(key);
      patch(key, {
        status: statusFor(info),
        exitCode: info.code,
        reason: info.reason,
        endedAt: Date.now(),
        connection: "connected",
      });
    },
    onLost: () => {
      flushOutput();
      followers.delete(key);
      const run = useShellRuns.getState().runs[key];
      // Gone from the server before an exit was seen: the output that was
      // shown is all there will be.
      if (run && (run.status === "running" || run.status === "starting")) {
        patch(key, { status: "lost", endedAt: Date.now(), connection: "connected" });
      }
    },
    onConnection: (state) => patch(key, { connection: state }),
  });
  followers.set(key, follower);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeKey(): string {
  return `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const stored = readStored();
// A run whose job was never created (the page went away while the request was
// on its way) has nothing to follow and nothing to wait for.
const restored = (stored?.runs ?? []).map((run) =>
  run.status === "starting" && !run.jobId ? { ...run, status: "lost" as const, endedAt: run.endedAt ?? Date.now() } : run
);

export const useShellRuns = create<ShellRunsState>((set, get) => ({
  runs: Object.fromEntries(restored.map((run) => [run.key, run])),
  cards: stored?.cards ?? {},

  start: async ({ key, command, projectId, cwd = "" }) => {
    followers.get(key)?.stop();
    followers.delete(key);
    set((state) => ({
      runs: {
        ...state.runs,
        [key]: {
          key,
          jobId: null,
          command,
          projectId,
          cwd,
          status: "starting",
          exitCode: null,
          reason: null,
          output: "",
          droppedChars: 0,
          startedAt: Date.now(),
          endedAt: null,
          error: null,
          connection: "connected",
        },
      },
    }));
    try {
      const { id } = await createTerminalJob({ kind: "run", projectId, cwd, command });
      patch(key, { jobId: id, status: "running" });
      follow(key, id);
    } catch (error) {
      patch(key, { status: "error", error: messageOf(error), endedAt: Date.now() });
    }
    schedulePersist();
  },

  stop: async (key) => {
    const run = get().runs[key];
    if (!run?.jobId) return;
    try {
      await stopTerminalJob(run.jobId);
    } catch {
      // Already over, or the server is gone; the stream says which.
    }
  },

  sendInput: async (key, text) => {
    const run = get().runs[key];
    if (!run?.jobId || run.status !== "running") return;
    try {
      await sendTerminalInput(run.jobId, text.endsWith("\n") ? text : `${text}\n`);
    } catch {
      // The run ended between the click and the request; nothing to add.
    }
  },

  resume: (key) => {
    const run = get().runs[key];
    if (!run?.jobId || followers.has(key)) return;
    if (run.status !== "running" && run.status !== "starting") return;
    follow(key, run.jobId);
  },

  dismiss: (key) => {
    followers.get(key)?.stop();
    followers.delete(key);
    set((state) => {
      const runs = { ...state.runs };
      delete runs[key];
      const cards: Record<string, ShellCard[]> = {};
      for (const [chatId, list] of Object.entries(state.cards)) {
        const rest = list.filter((card) => card.key !== key);
        if (rest.length) cards[chatId] = rest;
      }
      return { runs, cards };
    });
    schedulePersist();
  },

  addCard: ({ chatId, anchorId, command, projectId, cwd }) => {
    const key = makeKey();
    set((state) => ({
      cards: {
        ...state.cards,
        [chatId]: [...(state.cards[chatId] ?? []), { key, anchorId, createdAt: Date.now() }],
      },
    }));
    void get().start({ key, command, projectId, cwd });
    return key;
  },

  dismissCard: (chatId, key) => {
    void chatId;
    get().dismiss(key);
  },
}));
