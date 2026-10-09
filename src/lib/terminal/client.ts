/**
 * The browser's side of the terminal routes.
 *
 * Shared by the run cards in the chat and the panel, which talk to the same
 * jobs the same way: start one, follow its output from an offset, type into
 * it, stop it.
 */
import { readEvents } from "@/lib/terminal/sse";
import type { TerminalCloseReason, TerminalJobKind, TerminalStreamEvent } from "@/lib/terminal/protocol";

export class TerminalApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) {
    throw new TerminalApiError(payload?.error || `Request failed (${response.status})`, response.status, payload?.code ?? null);
  }
  return payload as T;
}

export interface CreateJobRequest {
  kind: TerminalJobKind;
  projectId: string | null;
  cwd?: string;
  command?: string;
  cols?: number;
  rows?: number;
}

export function createTerminalJob(request: CreateJobRequest): Promise<{ id: string; kind: TerminalJobKind; reused: boolean }> {
  return postJson("/api/terminal/jobs", request);
}

const jobUrl = (id: string, action: string) => `/api/terminal/jobs/${encodeURIComponent(id)}/${action}`;

export function sendTerminalInput(id: string, data: string): Promise<{ ok: boolean }> {
  return postJson(jobUrl(id, "input"), { data });
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<{ ok: boolean }> {
  return postJson(jobUrl(id, "resize"), { cols, rows });
}

export function stopTerminalJob(id: string): Promise<{ ok: boolean }> {
  return postJson(jobUrl(id, "stop"), {});
}

export interface FollowCallbacks {
  /** Where the stream starts; `truncated` when output the reader had was dropped. */
  onStart?(info: { from: number; total: number; truncated: boolean }): void;
  onOutput(text: string, offsetAfter: number): void;
  onExit(info: { code: number | null; signal: string | null; reason: TerminalCloseReason }): void;
  /** The server has no such job: it restarted, or the job was cleared. */
  onLost(): void;
  onConnection?(state: "connected" | "reconnecting"): void;
}

export interface Follower {
  /** Stop reading. The job itself keeps running. */
  stop(): void;
  /** Offset reached so far. */
  offset(): number;
}

const RETRY_DELAYS_MS = [400, 1000, 2000, 4000];
const MAX_RETRIES = 8;

export interface FollowOptions {
  /** Waits between attempts, the last repeating. For tests; the defaults are what a page wants. */
  retryDelaysMs?: number[];
  maxRetries?: number;
}

/**
 * Read a job's output from `from` until it ends, picking up again from the last
 * offset when the connection drops. A connection that ends without the job's
 * exit is a drop, not an ending; a 404 is the only thing that says it is gone.
 */
export function followTerminalJob(
  id: string,
  from: number,
  callbacks: FollowCallbacks,
  options: FollowOptions = {}
): Follower {
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : RETRY_DELAYS_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const controller = new AbortController();
  let offset = Math.max(0, from);
  let finished = false;

  const run = async () => {
    let failures = 0;
    while (!finished && !controller.signal.aborted) {
      try {
        const response = await fetch(`${jobUrl(id, "stream")}?from=${offset}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 404) {
          finished = true;
          callbacks.onLost();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        callbacks.onConnection?.("connected");
        for await (const event of readEvents<TerminalStreamEvent>(response.body)) {
          // Only an event proves the connection is useful; one that opens and
          // closes at once would otherwise retry forever at full speed.
          failures = 0;
          if (event.t === "s") {
            offset = event.from;
            callbacks.onStart?.({ from: event.from, total: event.total, truncated: event.truncated });
          } else if (event.t === "o") {
            offset = event.n;
            callbacks.onOutput(event.d, event.n);
          } else if (event.t === "x") {
            finished = true;
            callbacks.onExit({ code: event.code, signal: event.signal, reason: event.reason });
            return;
          }
        }
        // The stream ended without an exit: the connection dropped.
        if (controller.signal.aborted) return;
        throw new Error("stream ended");
      } catch {
        if (controller.signal.aborted || finished) return;
        failures += 1;
        if (failures > maxRetries) {
          finished = true;
          callbacks.onLost();
          return;
        }
        callbacks.onConnection?.("reconnecting");
        const delay = delays[Math.min(failures - 1, delays.length - 1)];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
  void run();

  return {
    stop() {
      controller.abort();
    },
    offset: () => offset,
  };
}
