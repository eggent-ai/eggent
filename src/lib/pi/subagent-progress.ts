import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "@/lib/pi/provider-failure";
import {
  isAgentToolName,
  parseSubagentActivity,
  parseTokenCount,
  splitAgentResult,
  toolResultText,
} from "@/lib/pi/subagent-format";
import type { SubagentSnapshot, SubagentStatus, SubagentStep } from "@/lib/pi/types";

/**
 * What each helper is doing while the turn waits for it, for the chat to show.
 *
 * Two sources, because neither is enough alone. The Agent tool reports progress
 * on its own call about twelve times a second: status, tool count, turns,
 * tokens and a one-line activity - live, but it only ever names a tool, never
 * what the tool was pointed at. The helper's transcript, which the extension
 * writes to its task directory after every one of the helper's turns, has the
 * rest: each search query, each page, each file. It lags by a turn, so it is
 * the list of what was done, and the activity line is what is happening now.
 *
 * The transcript is found by its first line, which is the prompt the helper was
 * given - the one thing the tool call and the file are both certain to carry.
 */

const MAX_STEPS = 40;
const MAX_TARGET_CHARS = 160;
const MAX_PROMPT_LINE_BYTES = 256 * 1024;

/** The extension's name for a working directory, reproduced exactly. */
export function encodeTranscriptCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")
    .replace(/^[A-Za-z]:-/, "")
    .replace(/^-+/, "");
}

/** Where pi-subagents writes the transcripts of one parent session's helpers. */
export function subagentTaskDir(cwd: string, sessionId: string, tmpRoot = os.tmpdir()): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(tmpRoot, `pi-subagents-${uid}`, encodeTranscriptCwd(cwd), sessionId, "tasks");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clip(text: string, limit = MAX_TARGET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    if (!strings.length) return undefined;
    return strings.length > 1 ? `${strings[0]} (+${strings.length - 1})` : strings[0];
  }
  return undefined;
}

/**
 * What a helper's tool call was pointed at, as one short line: the search, the
 * page, the file, the command. Secrets are masked - this is stored with the chat.
 */
export function describeStepTarget(tool: string, args: unknown): string | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  const name = tool.toLowerCase();
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = firstString(input[key]);
      if (value) return value;
    }
    return undefined;
  };
  let target: string | undefined;
  if (name === "web_search" || name === "source_check") target = pick("query", "queries", "q");
  else if (name === "fetch_content" || name === "get_search_content") target = pick("url", "urls", "query");
  else if (name === "read" || name === "write" || name === "edit" || name === "ls") target = pick("path", "file_path", "file");
  else if (name === "bash" || name === "powershell") target = pick("command");
  else if (name === "grep") target = pick("pattern", "query");
  else if (name === "find") target = pick("pattern", "path", "name");
  else if (name === "agent") target = pick("description");
  else {
    for (const value of Object.values(input)) {
      target = firstString(value);
      if (target) break;
    }
  }
  if (!target) return undefined;
  const firstLine = target.split("\n")[0];
  return clip(redactSecrets(firstLine));
}

interface Transcript {
  file: string;
  offset: number;
  remainder: string;
}

interface Entry {
  snapshot: SubagentSnapshot;
  prompt: string;
  transcript?: Transcript;
  stepIndex: Map<string, number>;
  lastEmitAt: number;
  emittedKey: string;
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

export interface SubagentProgressOptions {
  /** The parent session: its id and working directory name the task directory. */
  sessionId: string;
  cwd: string;
  /** Receives a copy of a helper's snapshot whenever something visible changed. */
  onChange?: (snapshot: SubagentSnapshot) => void;
  /** Fewest milliseconds between two reports for one helper; the latest always goes out. */
  throttleMs?: number;
  /** How often transcripts are read while helpers run. */
  pollMs?: number;
  /** Where the transcripts are, when not the extension's own default (tests). */
  taskDir?: string;
}

export class SubagentProgressTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly claimed = new Set<string>();
  private readonly taskDir: string;
  private readonly throttleMs: number;
  private readonly pollMs: number;
  private readonly options: SubagentProgressOptions;
  private poller: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  // A plain field, not a parameter property: tests load this file with Node's
  // type stripping, which cannot compile those.
  constructor(options: SubagentProgressOptions) {
    this.options = options;
    this.taskDir = options.taskDir ?? subagentTaskDir(options.cwd, options.sessionId);
    this.throttleMs = options.throttleMs ?? 500;
    this.pollMs = options.pollMs ?? 1000;
  }

  /** Feed every event of the parent session; anything but an Agent call is ignored. */
  handle(event: unknown): void {
    if (this.disposed) return;
    const record = asRecord(event);
    if (!record || !isAgentToolName(record.toolName)) return;
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
    if (!toolCallId) return;
    if (record.type === "tool_execution_start") this.start(toolCallId, record.args);
    else if (record.type === "tool_execution_update") this.update(toolCallId, record.partialResult);
    else if (record.type === "tool_execution_end") this.end(toolCallId, record.result, record.isError === true);
  }

  get(toolCallId: string): SubagentSnapshot | undefined {
    const entry = this.entries.get(toolCallId);
    return entry ? structuredClone(entry.snapshot) : undefined;
  }

  /** How many helpers of this turn are still working, and how many there are. */
  counts(): { running: number; total: number } {
    let running = 0;
    for (const entry of this.entries.values()) if (!entry.finished) running += 1;
    return { running, total: this.entries.size };
  }

  dispose(): void {
    this.disposed = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private start(toolCallId: string, rawArgs: unknown): void {
    const args = asRecord(rawArgs) ?? {};
    // A scheduled Agent call registers a job and returns at once; there is no
    // helper working in this turn to follow.
    if (typeof args.schedule === "string" && args.schedule.trim()) return;
    if (this.entries.has(toolCallId)) return;
    const description = typeof args.description === "string" && args.description.trim()
      ? clip(args.description, 120)
      : "";
    this.entries.set(toolCallId, {
      snapshot: {
        toolCallId,
        description,
        agentType: typeof args.subagent_type === "string" ? args.subagent_type : undefined,
        status: "running",
        startedAt: new Date().toISOString(),
        now: { kind: "thinking" },
        toolUses: 0,
        steps: [],
      },
      prompt: typeof args.prompt === "string" ? args.prompt : "",
      stepIndex: new Map(),
      lastEmitAt: 0,
      emittedKey: "",
      timer: null,
      finished: false,
    });
    this.ensurePolling();
    this.report(toolCallId, true);
  }

  private update(toolCallId: string, partialResult: unknown): void {
    const entry = this.entries.get(toolCallId);
    if (!entry || entry.finished) return;
    const details = asRecord(asRecord(partialResult)?.details);
    if (!details) return;
    this.applyDetails(entry.snapshot, details);
    const now = parseSubagentActivity(details.activity);
    if (now) entry.snapshot.now = now;
    this.report(toolCallId);
  }

  private end(toolCallId: string, result: unknown, isError: boolean): void {
    const entry = this.entries.get(toolCallId);
    if (!entry || entry.finished) return;
    this.readTranscript(entry);
    const snapshot = entry.snapshot;
    const details = asRecord(asRecord(result)?.details);
    if (details) this.applyDetails(snapshot, details);
    const { error } = splitAgentResult(toolResultText(result));
    const extensionStatus = typeof details?.status === "string" ? details.status : "";
    let status: SubagentStatus = "done";
    if (isError || extensionStatus === "error") status = "failed";
    else if (extensionStatus === "stopped" || extensionStatus === "aborted") status = "stopped";
    snapshot.status = status;
    if (status === "failed") {
      const reason = error
        ?? (typeof details?.error === "string" && details.error.trim() ? details.error : undefined)
        ?? toolResultText(result);
      snapshot.error = reason.trim() ? clip(redactSecrets(reason), 300) : undefined;
    }
    snapshot.endedAt = new Date().toISOString();
    delete snapshot.now;
    entry.finished = true;
    this.report(toolCallId, true);
    if (this.counts().running === 0 && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  private applyDetails(snapshot: SubagentSnapshot, details: Record<string, unknown>): void {
    if (typeof details.toolUses === "number") snapshot.toolUses = Math.max(snapshot.toolUses, details.toolUses);
    if (typeof details.turnCount === "number") snapshot.turns = details.turnCount;
    const tokens = parseTokenCount(details.tokens);
    if (tokens !== undefined) snapshot.tokens = tokens;
    if (typeof details.modelName === "string" && details.modelName.trim()) snapshot.model = details.modelName.trim();
    if (!snapshot.description && typeof details.description === "string") snapshot.description = clip(details.description, 120);
    if (!snapshot.agentType && typeof details.subagentType === "string") snapshot.agentType = details.subagentType;
  }

  private ensurePolling(): void {
    if (this.poller || this.disposed) return;
    this.poller = setInterval(() => this.poll(), this.pollMs);
    this.poller.unref?.();
  }

  private poll(): void {
    for (const [toolCallId, entry] of this.entries) {
      if (entry.finished) continue;
      if (this.readTranscript(entry)) this.report(toolCallId);
    }
  }

  /** Reads whatever the helper's transcript gained since last time. Returns whether steps changed. */
  private readTranscript(entry: Entry): boolean {
    if (!entry.transcript && !this.claimTranscript(entry)) return false;
    const transcript = entry.transcript!;
    let chunk = "";
    try {
      const stat = fs.statSync(transcript.file);
      if (stat.size <= transcript.offset) return false;
      const fd = fs.openSync(transcript.file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - transcript.offset);
        fs.readSync(fd, buffer, 0, buffer.length, transcript.offset);
        chunk = buffer.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
      transcript.offset = stat.size;
    } catch {
      return false;
    }
    const lines = (transcript.remainder + chunk).split("\n");
    transcript.remainder = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown> | null;
      try {
        parsed = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (parsed && this.applyTranscriptLine(entry, parsed)) changed = true;
    }
    return changed;
  }

  private claimTranscript(entry: Entry): boolean {
    if (!entry.prompt) return false;
    let files: string[];
    try {
      files = fs.readdirSync(this.taskDir).filter((file) => file.endsWith(".output"));
    } catch {
      return false;
    }
    for (const file of files) {
      const fullPath = path.join(this.taskDir, file);
      if (this.claimed.has(fullPath)) continue;
      const first = readFirstLine(fullPath);
      if (!first) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = asRecord(JSON.parse(first));
      } catch {
        continue;
      }
      const content = asRecord(parsed?.message)?.content;
      if (typeof content !== "string" || content !== entry.prompt) continue;
      this.claimed.add(fullPath);
      // The first line is the prompt itself; everything after it is the work.
      entry.transcript = { file: fullPath, offset: Buffer.byteLength(first, "utf-8") + 1, remainder: "" };
      return true;
    }
    return false;
  }

  private applyTranscriptLine(entry: Entry, line: Record<string, unknown>): boolean {
    const message = asRecord(line.message);
    if (!message) return false;
    const snapshot = entry.snapshot;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      let changed = false;
      for (const part of message.content) {
        const item = asRecord(part);
        if (item?.type !== "toolCall" || typeof item.name !== "string") continue;
        const step: SubagentStep = { tool: item.name };
        const target = describeStepTarget(item.name, item.arguments);
        if (target) step.target = target;
        snapshot.steps.push(step);
        if (typeof item.id === "string") entry.stepIndex.set(item.id, snapshot.steps.length - 1 + (snapshot.earlierSteps ?? 0));
        changed = true;
      }
      if (snapshot.steps.length > MAX_STEPS) {
        const drop = snapshot.steps.length - MAX_STEPS;
        snapshot.steps.splice(0, drop);
        snapshot.earlierSteps = (snapshot.earlierSteps ?? 0) + drop;
      }
      return changed;
    }
    if (message.role === "toolResult" && message.isError === true && typeof message.toolCallId === "string") {
      const absolute = entry.stepIndex.get(message.toolCallId);
      if (absolute === undefined) return false;
      const step = snapshot.steps[absolute - (snapshot.earlierSteps ?? 0)];
      if (!step || step.failed) return false;
      step.failed = true;
      return true;
    }
    return false;
  }

  private visibleKey(snapshot: SubagentSnapshot): string {
    return JSON.stringify([
      snapshot.status,
      snapshot.now?.kind,
      snapshot.now?.tools,
      snapshot.now?.text ? Math.floor(snapshot.now.text.length / 24) : 0,
      snapshot.toolUses,
      snapshot.turns,
      snapshot.tokens ? Math.floor(snapshot.tokens / 1000) : 0,
      snapshot.model,
      snapshot.steps.length,
      snapshot.earlierSteps,
      snapshot.steps.filter((step) => step.failed).length,
      snapshot.error,
    ]);
  }

  private report(toolCallId: string, immediately = false): void {
    const entry = this.entries.get(toolCallId);
    if (!entry || !this.options.onChange) return;
    const key = this.visibleKey(entry.snapshot);
    if (key === entry.emittedKey) return;
    const wait = immediately ? 0 : this.throttleMs - (Date.now() - entry.lastEmitAt);
    if (wait <= 0) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.emittedKey = key;
      entry.lastEmitAt = Date.now();
      try {
        this.options.onChange(structuredClone(entry.snapshot));
      } catch (error) {
        console.warn("A subagent progress listener failed:", error);
      }
      return;
    }
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!this.disposed) this.report(toolCallId, true);
    }, wait);
  }
}

function readFirstLine(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_PROMPT_LINE_BYTES);
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, read).toString("utf-8");
      const newline = text.indexOf("\n");
      return newline >= 0 ? text.slice(0, newline) : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
