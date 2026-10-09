/**
 * What passes between the terminal routes and the browser.
 *
 * Kept free of server and browser imports so both sides can load it, and so a
 * test can read the same definitions the routes use.
 *
 * Output travels as server-sent events and input as plain requests. Next has no
 * WebSocket in a route handler, and the workspace already streams events this
 * way, so a terminal costs no new kind of connection. Every event carries the
 * offset it leaves the stream at: a reader that lost its connection, or a page
 * that was reloaded, asks to continue from the last offset it saw and is given
 * exactly what it missed - nothing twice, nothing skipped.
 */

/** A one-off command with its output, or an interactive shell on a terminal. */
export type TerminalJobKind = "run" | "pty";

export type TerminalJobState = "running" | "exited";

/**
 * Why a job ended. `exit` is the process finishing by itself; the rest are
 * decisions, so the screen can say "closed after 30 minutes without use"
 * instead of showing a shell that stopped answering.
 */
export type TerminalCloseReason =
  | "exit"
  | "stopped"
  | "idle"
  | "detached"
  | "timeout"
  | "shutdown"
  | "error";

export type TerminalStreamEvent =
  /** First event of every stream: where the replay starts and where the job stands. */
  | { t: "s"; from: number; total: number; state: TerminalJobState; truncated: boolean }
  /** Output. `n` is the offset after this chunk. */
  | { t: "o"; d: string; n: number }
  /** The process has ended. Nothing follows. */
  | { t: "x"; code: number | null; signal: string | null; reason: TerminalCloseReason };

export interface TerminalJobSummary {
  id: string;
  kind: TerminalJobKind;
  state: TerminalJobState;
  /** Which terminal this is, for the kinds that are reused (one per project). */
  key: string | null;
  startedAt: number;
  endedAt: number | null;
  total: number;
}

/** Ids are minted here and nowhere else; anything else is not a job. */
export const TERMINAL_JOB_ID_PATTERN = /^(run|pty)_[0-9a-f]{32}$/;

export const TERMINAL_LIMITS = {
  /** What one request may send as keystrokes or a pasted block. */
  maxInputChars: 64 * 1024,
  /** A command somebody runs by clicking, not a script they would save. */
  maxCommandChars: 20_000,
  minCols: 10,
  maxCols: 500,
  minRows: 2,
  maxRows: 200,
} as const;

export function clampTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const toInt = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  };
  return {
    cols: Math.min(TERMINAL_LIMITS.maxCols, Math.max(TERMINAL_LIMITS.minCols, toInt(cols, 80))),
    rows: Math.min(TERMINAL_LIMITS.maxRows, Math.max(TERMINAL_LIMITS.minRows, toInt(rows, 24))),
  };
}
