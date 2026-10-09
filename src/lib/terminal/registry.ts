/**
 * The processes people start from the browser: a command run by a click, and a
 * shell in the side panel.
 *
 * They share one registry because they are the same thing seen from two sides -
 * a child process whose output has to reach a page that may not be looking at
 * it yet, may stop looking, and may come back. So a job keeps the output it has
 * produced (up to a cap) and any number of readers attach to it at an offset,
 * the same arrangement `live-run.ts` makes for an agent's turn. The request that
 * started a job is not what keeps it alive: reloading the page, switching to
 * another chat or closing the laptop lid does not end a build that was running.
 *
 * What does end one, and why a deployment that sleeps its idle workspaces needs
 * it written down:
 *   - a shell nobody has typed into or heard from for `idleMs` is closed,
 *   - a shell nobody is watching is closed after `detachMs`,
 *   - a command that runs past `runMaxMs` is stopped,
 *   - and finished jobs are forgotten after `keepFinishedMs`.
 * An open tab does not hold a workspace awake by itself - the reader is one long
 * request that ends with the job, nothing polls - but a forgotten shell would
 * otherwise sit in memory for as long as the container lives.
 *
 * The registry hangs off `globalThis`: routes are compiled separately, and a
 * module-level map is not one map per process (see `active-runs.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { PTY_HELPER_SOURCE } from "@/lib/terminal/pty-helper";
import {
  clampTerminalSize,
  type TerminalCloseReason,
  type TerminalJobKind,
  type TerminalJobState,
  type TerminalJobSummary,
} from "@/lib/terminal/protocol";

export interface TerminalLimits {
  maxRuns: number;
  maxPty: number;
  /** Characters of output kept per job for readers that attach late. */
  bufferChars: number;
  idleMs: number;
  detachMs: number;
  runMaxMs: number;
  keepFinishedMs: number;
  /** Finished jobs kept for late readers; the oldest go first. */
  maxFinished: number;
  killGraceMs: number;
  sweepMs: number;
}

function minutesFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultTerminalLimits(): TerminalLimits {
  return {
    maxRuns: 8,
    maxPty: 3,
    bufferChars: 1_000_000,
    idleMs: minutesFromEnv("EGGENT_TERMINAL_IDLE_MINUTES", 30) * 60_000,
    detachMs: minutesFromEnv("EGGENT_TERMINAL_DETACH_MINUTES", 30) * 60_000,
    runMaxMs: minutesFromEnv("EGGENT_TERMINAL_RUN_MAX_MINUTES", 60) * 60_000,
    keepFinishedMs: 15 * 60_000,
    maxFinished: 60,
    killGraceMs: 3_000,
    sweepMs: 15_000,
  };
}

export interface ShellSpec {
  path: string;
  /** Arguments that make the shell take a command, `-c` for bash. */
  args: string[];
  /** A shell that reads its command from stdin instead (legacy WSL bash). */
  commandFromStdin?: boolean;
}

export interface StartRunOptions {
  command: string;
  cwd: string;
  shell: ShellSpec;
  /** Run before the command, exactly as the agent's own bash tool does. */
  commandPrefix?: string;
  env?: Record<string, string | undefined>;
}

export interface StartPtyOptions {
  cwd: string;
  python: string;
  /** The shell and the arguments that make it interactive. */
  shellPath: string;
  shellArgs: string[];
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  /** A terminal with this key that is still running is returned instead of a new one. */
  key?: string;
}

export interface JobSubscriber {
  onOutput(text: string, offsetAfter: number): void;
  onExit(info: { code: number | null; signal: string | null; reason: TerminalCloseReason }): void;
}

export interface Attachment {
  /** Offset the replay starts at; later than asked for when output was dropped. */
  start: number;
  /** True when the reader asked for output that is no longer kept. */
  truncated: boolean;
  replay: string;
  total: number;
  state: TerminalJobState;
  exit: { code: number | null; signal: string | null; reason: TerminalCloseReason } | null;
  detach: () => void;
}

interface Job {
  id: string;
  kind: TerminalJobKind;
  key: string | null;
  child: ChildProcess;
  state: TerminalJobState;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  detachedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  reason: TerminalCloseReason;
  text: string;
  base: number;
  total: number;
  subscribers: Set<JobSubscriber>;
  decoders: StringDecoder[];
  killTimer: NodeJS.Timeout | null;
  settleTimer: NodeJS.Timeout | null;
  started: boolean;
  finished: boolean;
  /** Asked to stop and not gone yet: not a terminal to hand out, not one to count. */
  closing: boolean;
}

export class TerminalLimitError extends Error {
  readonly kind: TerminalJobKind;

  constructor(kind: TerminalJobKind) {
    super(kind === "pty" ? "Too many terminals are open." : "Too many commands are running.");
    this.kind = kind;
  }
}

function newId(kind: TerminalJobKind): string {
  return `${kind}_${randomBytes(16).toString("hex")}`;
}

export class TerminalRegistry {
  private readonly jobs = new Map<string, Job>();
  private sweeper: NodeJS.Timeout | null = null;
  readonly limits: TerminalLimits;

  constructor(limits: Partial<TerminalLimits> = {}) {
    this.limits = { ...defaultTerminalLimits(), ...limits };
  }

  // -- starting ------------------------------------------------------------

  startRun(options: StartRunOptions): string {
    this.assertRoom("run");
    const wrapped = options.commandPrefix ? `${options.commandPrefix}\n${options.command}` : options.command;
    const args = options.shell.commandFromStdin ? options.shell.args : [...options.shell.args, wrapped];
    const child = spawn(options.shell.path, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
        ...(process.env.TERM ? {} : { TERM: "dumb" }),
        ...options.env,
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const job = this.adopt("run", child, null);
    child.stdout?.on("data", (chunk: Buffer) => this.append(job, job.decoders[0].write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => this.append(job, job.decoders[1].write(chunk)));
    if (options.shell.commandFromStdin) child.stdin?.write(`${wrapped}\n`);
    return job.id;
  }

  /** Returns the id and whether an existing terminal was reused. */
  startPty(options: StartPtyOptions): { id: string; reused: boolean } {
    if (options.key) {
      for (const job of this.jobs.values()) {
        if (job.kind === "pty" && job.key === options.key && job.state === "running" && !job.closing) {
          this.resize(job.id, options.cols, options.rows);
          return { id: job.id, reused: true };
        }
      }
    }
    this.assertRoom("pty");
    const size = clampTerminalSize(options.cols, options.rows);
    const child = spawn(
      options.python,
      ["-I", "-u", "-c", PTY_HELPER_SOURCE, String(size.rows), String(size.cols), options.shellPath, ...options.shellArgs],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          ...options.env,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }
    );
    const job = this.adopt("pty", child, options.key ?? null);
    child.stdout?.on("data", (chunk: Buffer) => this.append(job, job.decoders[0].write(chunk)));
    // The helper's own complaints (a missing shell, a broken interpreter) are
    // the only thing on stderr, and a terminal that shows nothing is worse.
    child.stderr?.on("data", (chunk: Buffer) => this.append(job, job.decoders[1].write(chunk)));
    (child.stdio[3] as NodeJS.WritableStream | null)?.on?.("error", () => undefined);
    return { id: job.id, reused: false };
  }

  private assertRoom(kind: TerminalJobKind): void {
    let live = 0;
    for (const job of this.jobs.values()) {
      if (job.kind === kind && job.state === "running" && !job.closing) live += 1;
    }
    if (live >= (kind === "pty" ? this.limits.maxPty : this.limits.maxRuns)) throw new TerminalLimitError(kind);
  }

  private adopt(kind: TerminalJobKind, child: ChildProcess, key: string | null): Job {
    const now = Date.now();
    const job: Job = {
      id: newId(kind),
      kind,
      key,
      child,
      state: "running",
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      detachedAt: now,
      exitCode: null,
      exitSignal: null,
      reason: "exit",
      text: "",
      base: 0,
      total: 0,
      subscribers: new Set(),
      decoders: [new StringDecoder("utf8"), new StringDecoder("utf8")],
      killTimer: null,
      settleTimer: null,
      started: false,
      finished: false,
      closing: false,
    };
    this.pruneFinished();
    this.jobs.set(job.id, job);
    child.stdin?.on("error", () => undefined);
    child.once("spawn", () => {
      job.started = true;
    });
    child.once("error", (error: Error) => {
      if (job.finished) return;
      this.append(job, `${error.message}\r\n`);
      job.reason = "error";
      this.finish(job, 127, null);
    });
    child.once("exit", (code, signal) => {
      job.exitCode = code;
      job.exitSignal = signal;
      // The pipes usually end with the process, but a command that leaves a
      // background process holding them would never "close"; a moment is enough
      // for what was already written to arrive.
      job.settleTimer = setTimeout(() => this.finish(job, code, signal), 400);
      job.settleTimer.unref?.();
    });
    child.once("close", (code, signal) => this.finish(job, code, signal));
    this.ensureSweeper();
    return job;
  }

  // -- output --------------------------------------------------------------

  private append(job: Job, text: string): void {
    if (!text) return;
    job.text += text;
    job.total += text.length;
    job.lastActivityAt = Date.now();
    // Trimmed in steps, not on every chunk: slicing a megabyte string per
    // write would cost more than the output it makes room for.
    if (job.text.length > this.limits.bufferChars * 1.25) {
      const drop = job.text.length - this.limits.bufferChars;
      job.text = job.text.slice(drop);
      job.base += drop;
    }
    for (const subscriber of job.subscribers) {
      try {
        subscriber.onOutput(text, job.total);
      } catch {
        // One reader that threw must not stop the job or the other readers.
      }
    }
  }

  private finish(job: Job, code: number | null, signal: NodeJS.Signals | string | null): void {
    if (job.finished) return;
    job.finished = true;
    if (job.settleTimer) clearTimeout(job.settleTimer);
    if (job.killTimer) clearTimeout(job.killTimer);
    for (const decoder of job.decoders) {
      const rest = decoder.end();
      if (rest) this.append(job, rest);
    }
    job.state = "exited";
    job.endedAt = Date.now();
    job.exitCode = code ?? job.exitCode;
    job.exitSignal = (signal as string | null) ?? job.exitSignal;
    const info = { code: job.exitCode, signal: job.exitSignal, reason: job.reason };
    for (const subscriber of job.subscribers) {
      try {
        subscriber.onExit(info);
      } catch {
        // Same as above.
      }
    }
    job.subscribers.clear();
  }

  // -- readers -------------------------------------------------------------

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  summary(id: string): TerminalJobSummary | null {
    const job = this.jobs.get(id);
    return job ? this.describe(job) : null;
  }

  list(): TerminalJobSummary[] {
    return [...this.jobs.values()].map((job) => this.describe(job));
  }

  private describe(job: Job): TerminalJobSummary {
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      key: job.key,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      total: job.total,
    };
  }

  /**
   * Start reading a job at `from`.
   *
   * Registering and replaying happen in one synchronous step, so no chunk can
   * fall between what was replayed and what is delivered live. A reader that
   * asks for output that has since been dropped is started where the output
   * begins and told so.
   */
  attach(id: string, from: number, subscriber: JobSubscriber): Attachment | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const asked = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
    const start = Math.min(Math.max(asked, job.base), job.total);
    const truncated = asked < job.base;
    const replay = job.text.slice(start - job.base);
    const exit = job.finished
      ? { code: job.exitCode, signal: job.exitSignal, reason: job.reason }
      : null;
    if (!job.finished) {
      job.subscribers.add(subscriber);
      job.detachedAt = null;
    }
    let detached = false;
    return {
      start,
      truncated,
      replay,
      total: job.total,
      state: job.state,
      exit,
      detach: () => {
        if (detached) return;
        detached = true;
        job.subscribers.delete(subscriber);
        if (job.subscribers.size === 0) job.detachedAt = Date.now();
      },
    };
  }

  // -- writing -------------------------------------------------------------

  write(id: string, data: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return false;
    const stdin = job.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    job.lastActivityAt = Date.now();
    stdin.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const job = this.jobs.get(id);
    if (!job || job.kind !== "pty" || job.state !== "running") return false;
    const size = clampTerminalSize(cols, rows);
    const control = job.child.stdio[3] as NodeJS.WritableStream | null | undefined;
    if (!control || (control as { destroyed?: boolean }).destroyed) return false;
    control.write(`R ${size.rows} ${size.cols}\n`);
    return true;
  }

  // -- ending --------------------------------------------------------------

  /** Ask the process group to stop, and make sure it does. */
  kill(id: string, reason: TerminalCloseReason = "stopped"): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return false;
    if (job.reason === "exit") job.reason = reason;
    job.closing = true;
    this.signalGroup(job, "SIGTERM");
    if (!job.killTimer) {
      job.killTimer = setTimeout(() => {
        job.killTimer = null;
        if (!job.finished) this.signalGroup(job, "SIGKILL");
      }, this.limits.killGraceMs);
      job.killTimer.unref?.();
    }
    return true;
  }

  private signalGroup(job: Job, signal: NodeJS.Signals): void {
    const pid = job.child.pid;
    if (pid && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Not a group leader any more, or already gone; fall through.
      }
    }
    try {
      job.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  killAll(reason: TerminalCloseReason = "shutdown"): void {
    for (const job of this.jobs.values()) {
      if (job.state === "running") {
        job.reason = reason;
        this.signalGroup(job, "SIGKILL");
      }
    }
  }

  // -- housekeeping --------------------------------------------------------

  /** A page that fires a hundred quick commands must not leave a hundred buffers behind. */
  private pruneFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.state === "exited")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const job of finished.slice(0, Math.max(0, finished.length - this.limits.maxFinished + 1))) {
      this.jobs.delete(job.id);
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), this.limits.sweepMs);
    this.sweeper.unref?.();
  }

  /** Public so a test can run it without waiting. */
  sweep(now = Date.now()): void {
    for (const job of [...this.jobs.values()]) {
      if (job.state === "exited") {
        if (job.endedAt !== null && now - job.endedAt > this.limits.keepFinishedMs && job.subscribers.size === 0) {
          this.jobs.delete(job.id);
        }
        continue;
      }
      if (job.kind === "pty") {
        if (now - job.lastActivityAt > this.limits.idleMs) {
          this.kill(job.id, "idle");
        } else if (job.detachedAt !== null && now - job.detachedAt > this.limits.detachMs) {
          this.kill(job.id, "detached");
        }
      } else if (now - job.startedAt > this.limits.runMaxMs) {
        this.kill(job.id, "timeout");
      }
    }
    if (this.jobs.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}

const GLOBAL_KEY = Symbol.for("eggent.terminal.registry");

export function getTerminalRegistry(): TerminalRegistry {
  const holder = globalThis as unknown as Record<symbol, TerminalRegistry | undefined>;
  let registry = holder[GLOBAL_KEY];
  if (!registry) {
    registry = new TerminalRegistry();
    holder[GLOBAL_KEY] = registry;
    // Children are detached so a stop can reach the whole group, which also
    // means they would outlive this process. Taking them down with it is the
    // best that can be done from inside; a process killed outright leaves the
    // helper to notice its stdin closed.
    const shutdown = registry;
    process.once("exit", () => shutdown.killAll("shutdown"));
  }
  return registry;
}
