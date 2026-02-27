import fs from "fs";
import path from "path";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import type { AppSettings } from "@/lib/types";

type ExecutionRuntime = "python" | "nodejs" | "terminal";

type TerminalSessionState = {
  cwd: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  stdoutTail: string;
  stderrTail: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
};

export type ExecuteCodeOptions = {
  background?: boolean;
  yieldMs?: number;
};

export type ManagedProcessStatus = "running" | "completed" | "failed" | "killed";

export type ManagedProcessSummary = {
  sessionId: string;
  runtime: ExecutionRuntime;
  commandPreview: string;
  status: ManagedProcessStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pid?: number;
  cwd: string;
  exitCode?: number | null;
  timedOut: boolean;
  truncated: boolean;
  tail: string;
};

export type ManagedProcessPollResult = {
  success: boolean;
  status: ManagedProcessStatus | "not_found";
  sessionId: string;
  output: string;
  retryInMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  startedAt?: number;
  finishedAt?: number;
};

export type ManagedProcessLogResult = {
  success: boolean;
  status: ManagedProcessStatus | "not_found";
  sessionId: string;
  output: string;
  totalLines?: number;
  truncated?: boolean;
};

export type ManagedProcessKillResult = {
  success: boolean;
  status: "killed" | "already_finished" | "not_found";
  sessionId: string;
  message: string;
};

type ManagedProcessSession = {
  id: string;
  runtime: ExecutionRuntime;
  commandPreview: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  cwd: string;
  pid?: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  timedOut: boolean;
  killedByUser: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  combined: string;
  truncated: boolean;
  process?: ChildProcess;
  completion: Promise<void>;
  resolveCompletion: () => void;
  version: number;
  lastPolledVersion: number;
  noProgressPollCount: number;
  terminalMarker?: string;
  terminalState?: TerminalSessionState;
};

type PreparedExecution = {
  runtime: ExecutionRuntime;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  commandPreview: string;
  terminalMarker?: string;
  terminalState?: TerminalSessionState;
};

const OUTPUT_TRUNCATED_MARKER = "[output truncated]";
const OUTPUT_TAIL_CHARS = 8192;
const DEFAULT_YIELD_MS = 10_000;
const MIN_YIELD_MS = 10;
const MAX_YIELD_MS = 120_000;
const PROCESS_LOG_DEFAULT_TAIL_LINES = 200;
const PROCESS_SESSION_TTL_MS = 30 * 60_000;
const POLL_BACKOFF_SCHEDULE_MS = [5_000, 10_000, 30_000, 60_000] as const;

const terminalSessions: Map<number, TerminalSessionState> = new Map();
const runningProcessSessions: Map<string, ManagedProcessSession> = new Map();
const finishedProcessSessions: Map<string, ManagedProcessSession> = new Map();
let cachedLoginShellPath: string | null | undefined;

const sweeper = setInterval(() => {
  pruneFinishedProcessSessions();
}, 60_000);
sweeper.unref?.();

/**
 * Execute code in a specified runtime
 */
export async function executeCode(
  runtime: ExecutionRuntime,
  code: string,
  sessionId: number,
  config: AppSettings["codeExecution"],
  cwd?: string,
  options?: ExecuteCodeOptions
): Promise<string> {
  const timeoutMs = toPositiveInteger(config.timeout, 180) * 1000;
  const maxOutput = toPositiveInteger(config.maxOutputLength, 50000);
  const baseCwd = cwd || process.cwd();
  const runInBackground = options?.background === true;
  const yieldMs =
    typeof options?.yieldMs === "number" && Number.isFinite(options.yieldMs)
      ? Math.min(Math.max(Math.floor(options.yieldMs), MIN_YIELD_MS), MAX_YIELD_MS)
      : null;

  try {
    const prepared = prepareExecution({
      runtime,
      code,
      sessionId,
      cwd: baseCwd,
    });

    if (!runInBackground && yieldMs === null) {
      const result = await runCommand(prepared.command, prepared.args, {
        timeout: timeoutMs,
        maxOutput,
        cwd: prepared.cwd,
        env: prepared.env,
      });
      applyTerminalMarkerIfNeeded(prepared, result);
      return formatCommandResult(result);
    }

    const managed = startManagedExecution({
      prepared,
      timeoutMs,
      maxOutput,
    });

    if (runInBackground) {
      return formatManagedSessionRunning(managed, true);
    }

    const waitMs = yieldMs ?? DEFAULT_YIELD_MS;
    const completedBeforeYield = await waitForManagedCompletion(managed, waitMs);
    if (!completedBeforeYield) {
      return formatManagedSessionRunning(managed, false);
    }

    return formatManagedSessionResult(managed);
  } catch (error) {
    return `Execution error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function listManagedProcessSessions(): ManagedProcessSummary[] {
  const summaries = [
    ...Array.from(runningProcessSessions.values()),
    ...Array.from(finishedProcessSessions.values()),
  ].map(toManagedSummary);

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}

export async function pollManagedProcessSession(
  sessionId: string,
  timeoutMs?: number
): Promise<ManagedProcessPollResult> {
  const id = sessionId.trim();
  if (!id) {
    return {
      success: false,
      status: "not_found",
      sessionId,
      output: "session_id is required",
    };
  }

  const session = getAnyProcessSession(id);
  if (!session) {
    return {
      success: false,
      status: "not_found",
      sessionId: id,
      output: `No session found for ${id}`,
    };
  }

  const wait =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(0, Math.min(Math.floor(timeoutMs), 120_000))
      : 0;

  if (session.status === "running" && wait > 0) {
    const startVersion = session.version;
    const deadline = Date.now() + wait;
    while (session.status === "running" && session.version === startVersion && Date.now() < deadline) {
      await sleep(Math.min(250, deadline - Date.now()));
    }
  }

  const hasNewOutput = session.version !== session.lastPolledVersion;
  session.lastPolledVersion = session.version;
  if (session.status === "running") {
    session.noProgressPollCount = hasNewOutput ? 0 : session.noProgressPollCount + 1;
  } else {
    session.noProgressPollCount = 0;
  }

  const retryInMs =
    session.status === "running"
      ? POLL_BACKOFF_SCHEDULE_MS[Math.min(session.noProgressPollCount, POLL_BACKOFF_SCHEDULE_MS.length - 1)]
      : undefined;

  return {
    success: true,
    status: session.status,
    sessionId: session.id,
    output: formatManagedSessionOutput(session),
    retryInMs,
    exitCode: session.status === "running" ? undefined : session.exitCode,
    timedOut: session.timedOut,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
  };
}

export function readManagedProcessSessionLog(
  sessionId: string,
  offset?: number,
  limit?: number
): ManagedProcessLogResult {
  const id = sessionId.trim();
  if (!id) {
    return {
      success: false,
      status: "not_found",
      sessionId,
      output: "session_id is required",
    };
  }

  const session = getAnyProcessSession(id);
  if (!session) {
    return {
      success: false,
      status: "not_found",
      sessionId: id,
      output: `No session found for ${id}`,
    };
  }

  const lines = session.combined.replace(/\r\n/g, "\n").split("\n");
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : usingDefaultTail
        ? PROCESS_LOG_DEFAULT_TAIL_LINES
        : lines.length;
  const effectiveOffset =
    typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : Math.max(0, lines.length - effectiveLimit);
  const slice = lines.slice(effectiveOffset, effectiveOffset + effectiveLimit).join("\n").trim();

  return {
    success: true,
    status: session.status,
    sessionId: session.id,
    output: slice || "(no output)",
    totalLines: lines.length,
    truncated: session.truncated,
  };
}

export function killManagedProcessSession(sessionId: string): ManagedProcessKillResult {
  const id = sessionId.trim();
  if (!id) {
    return {
      success: false,
      status: "not_found",
      sessionId,
      message: "session_id is required",
    };
  }

  const running = runningProcessSessions.get(id);
  if (!running) {
    const existing = finishedProcessSessions.get(id);
    if (existing) {
      return {
        success: true,
        status: "already_finished",
        sessionId: id,
        message: `Session ${id} has already finished with status ${existing.status}.`,
      };
    }
    return {
      success: false,
      status: "not_found",
      sessionId: id,
      message: `No session found for ${id}`,
    };
  }

  running.killedByUser = true;
  running.updatedAt = Date.now();
  if (running.process) {
    terminateProcess(running.process);
  }

  return {
    success: true,
    status: "killed",
    sessionId: id,
    message: `Sent termination signal to session ${id}.`,
  };
}

export function clearFinishedManagedProcessSessions(): { removed: number } {
  const removed = finishedProcessSessions.size;
  finishedProcessSessions.clear();
  return { removed };
}

export function removeManagedProcessSession(sessionId: string): { removed: boolean } {
  const id = sessionId.trim();
  if (!id) {
    return { removed: false };
  }
  return { removed: finishedProcessSessions.delete(id) };
}

/**
 * Clean up all sessions
 */
export function cleanupSessions(): void {
  terminalSessions.clear();
  for (const session of runningProcessSessions.values()) {
    session.killedByUser = true;
    if (session.process) {
      terminateProcess(session.process);
    }
  }
  runningProcessSessions.clear();
  finishedProcessSessions.clear();
}

function prepareExecution(params: {
  runtime: ExecutionRuntime;
  code: string;
  sessionId: number;
  cwd: string;
}): PreparedExecution {
  if (params.runtime === "python") {
    return {
      runtime: "python",
      command: "python3",
      args: ["-c", params.code],
      cwd: params.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      commandPreview: `python3 -c ${previewText(params.code)}`,
    };
  }

  if (params.runtime === "nodejs") {
    return {
      runtime: "nodejs",
      command: "node",
      args: ["-e", params.code],
      cwd: params.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      commandPreview: `node -e ${previewText(params.code)}`,
    };
  }

  const shell = process.env.SHELL?.trim() || "sh";
  const normalizedSessionId =
    Number.isFinite(params.sessionId) && params.sessionId >= 0 ? Math.floor(params.sessionId) : 0;
  const terminalState = terminalSessions.get(normalizedSessionId) ?? { cwd: params.cwd };
  terminalSessions.set(normalizedSessionId, terminalState);

  const marker = `__EGGENT_SESSION_RESULT_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const rewrittenCode = rewriteAptCommandsWithSudo(params.code);
  const wrapped = [
    "set +e",
    rewrittenCode,
    "__eggent_exit=$?",
    '__eggent_pwd="$(pwd)"',
    `printf "\\n${marker}\\t%s\\t%s\\n" "$__eggent_exit" "$__eggent_pwd"`,
    "exit $__eggent_exit",
  ].join("\n");

  return {
    runtime: "terminal",
    command: shell,
    args: ["-lc", wrapped],
    cwd: terminalState.cwd || params.cwd,
    env: buildTerminalEnv(shell),
    commandPreview: previewText(params.code),
    terminalMarker: marker,
    terminalState,
  };
}

function startManagedExecution(params: {
  prepared: PreparedExecution;
  timeoutMs: number;
  maxOutput: number;
}): ManagedProcessSession {
  const id = createManagedProcessId();
  let resolveCompletion = () => {
    // replaced below
  };
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const session: ManagedProcessSession = {
    id,
    runtime: params.prepared.runtime,
    commandPreview: params.prepared.commandPreview,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    cwd: params.prepared.cwd,
    status: "running",
    exitCode: null,
    timedOut: false,
    killedByUser: false,
    stdout: "",
    stderr: "",
    combined: "",
    truncated: false,
    completion,
    resolveCompletion,
    version: 0,
    lastPolledVersion: 0,
    noProgressPollCount: 0,
    terminalMarker: params.prepared.terminalMarker,
    terminalState: params.prepared.terminalState,
  };

  const proc = spawn(params.prepared.command, params.prepared.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: params.prepared.env,
    cwd: params.prepared.cwd,
  });

  session.process = proc;
  session.pid = proc.pid ?? undefined;

  let finalized = false;
  const timeoutHandle = setTimeout(() => {
    session.timedOut = true;
    session.updatedAt = Date.now();
    terminateProcess(proc);
  }, params.timeoutMs);

  const finalize = () => {
    if (finalized) {
      return;
    }
    finalized = true;
    clearTimeout(timeoutHandle);

    applyTerminalMarkerToSession(session);

    if (session.killedByUser) {
      session.status = "killed";
    } else if (session.timedOut) {
      session.status = "failed";
    } else if (session.spawnError) {
      session.status = "failed";
    } else {
      const code = session.exitCode ?? 0;
      session.status = code === 0 ? "completed" : "failed";
    }

    session.finishedAt = Date.now();
    session.updatedAt = session.finishedAt;
    session.version += 1;

    runningProcessSessions.delete(session.id);
    finishedProcessSessions.set(session.id, session);
    session.resolveCompletion();
  };

  proc.stdout?.on("data", (data: Buffer) => {
    appendManagedOutput(session, "stdout", data.toString(), params.maxOutput);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    appendManagedOutput(session, "stderr", data.toString(), params.maxOutput);
  });

  proc.on("close", (code) => {
    session.exitCode = code;
    finalize();
  });

  proc.on("error", (error) => {
    session.spawnError = error.message;
    finalize();
  });

  runningProcessSessions.set(session.id, session);
  return session;
}

function appendManagedOutput(
  session: ManagedProcessSession,
  stream: "stdout" | "stderr",
  chunk: string,
  maxOutput: number
): void {
  const streamBuffer = stream === "stdout" ? session.stdout : session.stderr;
  const streamCapped = appendTailWithCap(streamBuffer, chunk, maxOutput);
  if (stream === "stdout") {
    session.stdout = streamCapped.text;
  } else {
    session.stderr = streamCapped.text;
  }

  const combinedCapped = appendTailWithCap(session.combined, chunk, maxOutput);
  session.combined = combinedCapped.text;
  session.truncated = session.truncated || streamCapped.truncated || combinedCapped.truncated;
  session.updatedAt = Date.now();
  session.version += 1;
}

function appendTailWithCap(
  current: string,
  chunk: string,
  maxOutput: number
): { text: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= maxOutput) {
    return { text: combined, truncated: false };
  }

  const marker = `${OUTPUT_TRUNCATED_MARKER}\n`;
  const keepChars = Math.max(0, maxOutput - marker.length);
  const tail = combined.slice(combined.length - keepChars);
  return {
    text: `${marker}${tail}`,
    truncated: true,
  };
}

function applyTerminalMarkerIfNeeded(prepared: PreparedExecution, result: CommandResult): void {
  if (prepared.runtime !== "terminal" || !prepared.terminalMarker) {
    return;
  }

  const parsed = parseSessionMarker(prepared.terminalMarker, result.stdout, result.stdoutTail);
  result.stdout = parsed.cleanedStdout;
  if (parsed.exitCode !== null) {
    result.exitCode = parsed.exitCode;
  }
  if (prepared.terminalState && parsed.cwd && path.isAbsolute(parsed.cwd)) {
    prepared.terminalState.cwd = parsed.cwd;
  }
}

function applyTerminalMarkerToSession(session: ManagedProcessSession): void {
  if (session.runtime !== "terminal" || !session.terminalMarker) {
    return;
  }

  const parsed = parseSessionMarker(session.terminalMarker, session.stdout, session.stdout);
  session.stdout = parsed.cleanedStdout;
  if (parsed.exitCode !== null) {
    session.exitCode = parsed.exitCode;
  }
  if (session.terminalState && parsed.cwd && path.isAbsolute(parsed.cwd)) {
    session.terminalState.cwd = parsed.cwd;
  }
}

function parseSessionMarker(
  marker: string,
  stdout: string,
  stdoutTail: string
): {
  exitCode: number | null;
  cwd: string | null;
  cleanedStdout: string;
} {
  const escapedMarker = escapeRegExp(marker);
  const markerRegex = new RegExp(`${escapedMarker}\\t(-?\\d+)\\t([^\\r\\n]*)`);
  const markerRemovalRegex = new RegExp(
    `(?:\\r?\\n)?${escapedMarker}\\t-?\\d+\\t[^\\r\\n]*(?:\\r?\\n)?`,
    "g"
  );

  const scanText = `${stdout}\n${stdoutTail}`;
  const match = scanText.match(markerRegex);
  const exitCode = match && typeof match[1] === "string" ? Number.parseInt(match[1], 10) : null;
  const cwd = match && typeof match[2] === "string" ? match[2].trim() : null;
  const cleanedStdout = stdout.replace(markerRemovalRegex, "\n").trimEnd();

  return {
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    cwd: cwd || null,
    cleanedStdout,
  };
}

async function waitForManagedCompletion(
  session: ManagedProcessSession,
  waitMs: number
): Promise<boolean> {
  const boundedWait = Math.max(MIN_YIELD_MS, Math.min(waitMs, MAX_YIELD_MS));
  const timedOut = await Promise.race([
    session.completion.then(() => false),
    sleep(boundedWait).then(() => true),
  ]);
  return !timedOut;
}

function toManagedSummary(session: ManagedProcessSession): ManagedProcessSummary {
  return {
    sessionId: session.id,
    runtime: session.runtime,
    commandPreview: session.commandPreview,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    finishedAt: session.finishedAt,
    pid: session.pid,
    cwd: session.cwd,
    exitCode: session.status === "running" ? undefined : session.exitCode,
    timedOut: session.timedOut,
    truncated: session.truncated,
    tail: trimTail(session.combined, 2000),
  };
}

function formatManagedSessionRunning(session: ManagedProcessSession, immediate: boolean): string {
  const header = immediate
    ? "[Background execution started]"
    : "[Execution yielded to background]";
  return (
    `${header}\n` +
    `Session ID: ${session.id}\n` +
    `Runtime: ${session.runtime}\n` +
    `PID: ${session.pid ?? "n/a"}\n` +
    `Use process tool (action=\"poll\") with session_id=\"${session.id}\" to continue.`
  );
}

function formatManagedSessionResult(session: ManagedProcessSession): string {
  const output = formatManagedSessionOutput(session);
  const parts: string[] = [output];

  if (session.timedOut) {
    parts.push("[Process killed after timeout]");
  }
  if (session.spawnError) {
    parts.push(`Process error: ${session.spawnError}`);
  }
  if (session.status !== "running" && session.exitCode !== null && session.exitCode !== 0) {
    parts.push(`Exit code: ${session.exitCode}`);
  }

  return parts.join("\n\n").trim() || "(no output)";
}

function formatManagedSessionOutput(session: ManagedProcessSession): string {
  const parts: string[] = [];
  if (session.stdout.trim()) {
    parts.push(`STDOUT:\n${session.stdout.trim()}`);
  }
  if (session.stderr.trim()) {
    parts.push(`STDERR:\n${session.stderr.trim()}`);
  }
  if (session.truncated) {
    parts.push(OUTPUT_TRUNCATED_MARKER);
  }
  if (parts.length === 0) {
    return session.status === "running" ? "(no output yet)" : "(no output)";
  }
  return parts.join("\n\n");
}

function getAnyProcessSession(sessionId: string): ManagedProcessSession | null {
  return runningProcessSessions.get(sessionId) ?? finishedProcessSessions.get(sessionId) ?? null;
}

function pruneFinishedProcessSessions(): void {
  const cutoff = Date.now() - PROCESS_SESSION_TTL_MS;
  for (const [sessionId, session] of finishedProcessSessions.entries()) {
    if ((session.finishedAt ?? 0) < cutoff) {
      finishedProcessSessions.delete(sessionId);
    }
  }
}

/**
 * Run a shell command with timeout and output limits
 */
function runCommand(
  command: string,
  args: string[],
  options: {
    timeout: number;
    maxOutput: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false;

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
      cwd: options.cwd,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdoutTail = trimTail(stdoutTail + chunk, OUTPUT_TAIL_CHARS);
      stdout = appendWithLimit(stdout, chunk, options.maxOutput);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrTail = trimTail(stderrTail + chunk, OUTPUT_TAIL_CHARS);
      stderr = appendWithLimit(stderr, chunk, options.maxOutput);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(proc);
    }, options.timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        stdoutTail,
        stderrTail,
        exitCode: code,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        stdoutTail,
        stderrTail,
        exitCode: null,
        timedOut,
        spawnError: err.message,
      });
    });
  });
}

function terminateProcess(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 2000);
}

function formatCommandResult(result: CommandResult): string {
  const parts: string[] = [];
  if (result.stdout.trim()) {
    parts.push(`STDOUT:\n${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    parts.push(`STDERR:\n${result.stderr.trim()}`);
  }
  if (result.spawnError) {
    parts.push(`Process error: ${result.spawnError}`);
  }
  if (result.timedOut) {
    parts.push("[Process killed after timeout]");
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    parts.push(`Exit code: ${result.exitCode}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "(no output)";
}

function rewriteAptCommandsWithSudo(code: string): string {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot || !hasCommandInPath("sudo", process.env.PATH)) {
    return code;
  }

  const lines = code.split("\n");
  let changed = false;

  const rewritten = lines.map((line) => {
    if (!line.trim() || line.trim().startsWith("#")) {
      return line;
    }

    let next = line.replace(/(^|&&|\|\||;)\s*apt-get\b/g, "$1 sudo apt-get");
    next = next.replace(/(^|&&|\|\||;)\s*apt\b/g, "$1 sudo apt");
    if (next !== line) {
      changed = true;
    }
    return next;
  });

  if (!changed) {
    return code;
  }

  return ['echo "[eggent] Auto-added sudo for apt/apt-get command(s)"', ...rewritten].join("\n");
}

function buildTerminalEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
  };

  const loginShellPath = getLoginShellPath(shell);
  if (loginShellPath) {
    env.PATH = mergePath(loginShellPath, env.PATH);
  }

  return env;
}

function mergePath(primary: string, secondary?: string): string {
  const delimiter = path.delimiter;
  const entries = [...primary.split(delimiter), ...(secondary ? secondary.split(delimiter) : [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(delimiter);
}

function getLoginShellPath(shell: string): string | null {
  if (cachedLoginShellPath !== undefined) {
    return cachedLoginShellPath;
  }
  if (process.platform === "win32") {
    cachedLoginShellPath = null;
    return cachedLoginShellPath;
  }

  try {
    const raw = execFileSync(shell, ["-lc", 'printf "%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    cachedLoginShellPath = value && value.length > 0 ? value : null;
  } catch {
    cachedLoginShellPath = null;
  }

  return cachedLoginShellPath;
}

function hasCommandInPath(command: string, envPath?: string): boolean {
  const rawPath = envPath ?? process.env.PATH;
  if (!rawPath) {
    return false;
  }
  for (const dir of rawPath.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, command);
    if (fs.existsSync(candidate)) {
      return true;
    }
  }
  return false;
}

function appendWithLimit(current: string, chunk: string, maxOutput: number): string {
  if (current.length >= maxOutput) {
    if (!current.includes(OUTPUT_TRUNCATED_MARKER)) {
      return `${current}\n${OUTPUT_TRUNCATED_MARKER}`;
    }
    return current;
  }

  const remaining = maxOutput - current.length;
  if (chunk.length <= remaining) {
    return current + chunk;
  }

  const base = current + chunk.slice(0, Math.max(0, remaining));
  if (base.includes(OUTPUT_TRUNCATED_MARKER)) {
    return base;
  }
  return `${base}\n${OUTPUT_TRUNCATED_MARKER}`;
}

function trimTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function createManagedProcessId(): string {
  return `proc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function previewText(text: string, maxChars = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
