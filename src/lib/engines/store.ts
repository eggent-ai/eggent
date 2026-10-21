/**
 * What is kept per computer about engines: which project runs on which, and
 * which of the program's sessions a chat has.
 *
 * Both live in the agent's own folder (data/pi-agent), which is never synced.
 * That is the point. A project's model.json lives in the project and travels
 * with it, so a choice kept there would follow the project to the cloud and be
 * undone by a model chosen on the other side; an engine is a fact about this
 * computer. A program's session id is no use anywhere else either.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getPiAgentDir } from "@/lib/pi/config-store";
import { engineScopeKey, isEngineAccess, type EngineChoice } from "@/lib/engines/types";

const CHOICES_FILE = "engines.json";
const SESSIONS_FILE = "engine-sessions.json";
const MAX_SESSIONS = 400;

export interface EngineSessionRecord {
  engine: string;
  sessionId: string;
  cwd: string;
  /** What the session was started with; a changed brief is told to it rather than starting over. */
  briefKey: string;
  at: string;
}

function choicesPath(): string {
  return path.join(getPiAgentDir(), CHOICES_FILE);
}

function sessionsPath(): string {
  return path.join(getPiAgentDir(), SESSIONS_FILE);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// One writer at a time per file; a change reads the file again inside the turn.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(file, next.catch(() => undefined));
  return next;
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function cleanChoice(value: unknown): EngineChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.engine !== "string" || !record.engine.trim()) return null;
  return {
    engine: record.engine.trim(),
    model: typeof record.model === "string" ? record.model.trim() : "",
    access: isEngineAccess(record.access) ? record.access : "project",
    ...(typeof record.consentAt === "string" && record.consentAt ? { consentAt: record.consentAt } : {}),
  };
}

interface ChoicesDocument {
  choices: Record<string, EngineChoice>;
  /** What the person has said yes to, kept when they turn a program off: asking again each time would be a nuisance. */
  consents: Record<string, Record<string, string>>;
}

async function readDocument(): Promise<ChoicesDocument> {
  const document = await readJson(choicesPath());
  const choices: Record<string, EngineChoice> = {};
  const raw = document.choices;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const choice = cleanChoice(value);
      if (choice) choices[key] = choice;
    }
  }
  const consents: Record<string, Record<string, string>> = {};
  const rawConsents = document.consents;
  if (rawConsents && typeof rawConsents === "object" && !Array.isArray(rawConsents)) {
    for (const [key, perEngine] of Object.entries(rawConsents as Record<string, unknown>)) {
      if (!perEngine || typeof perEngine !== "object" || Array.isArray(perEngine)) continue;
      const clean: Record<string, string> = {};
      for (const [engine, at] of Object.entries(perEngine as Record<string, unknown>)) {
        if (typeof at === "string" && at) clean[engine] = at;
      }
      if (Object.keys(clean).length > 0) consents[key] = clean;
    }
  }
  return { choices, consents };
}

export async function readEngineChoices(): Promise<Record<string, EngineChoice>> {
  return (await readDocument()).choices;
}

export async function readEngineChoice(projectId: string | null | undefined): Promise<EngineChoice | null> {
  const choices = await readEngineChoices();
  return Object.prototype.hasOwnProperty.call(choices, engineScopeKey(projectId)) ? choices[engineScopeKey(projectId)] : null;
}

/** The programs this project (or the orchestrator) has been confirmed for, with the time of each yes. */
export async function readEngineConsents(projectId: string | null | undefined): Promise<Record<string, string>> {
  const { consents } = await readDocument();
  const key = engineScopeKey(projectId);
  return Object.prototype.hasOwnProperty.call(consents, key) ? { ...consents[key] } : {};
}

/** Sets a project's engine, or clears it with null. A confirmed choice is remembered even after it is cleared. */
export async function writeEngineChoice(projectId: string | null | undefined, choice: EngineChoice | null): Promise<void> {
  const key = engineScopeKey(projectId);
  await serialized(choicesPath(), async () => {
    const document = await readDocument();
    if (choice) {
      document.choices[key] = choice;
      if (choice.consentAt) document.consents[key] = { ...(document.consents[key] ?? {}), [choice.engine]: choice.consentAt };
    } else {
      delete document.choices[key];
    }
    await writeAtomic(choicesPath(), { version: 1, ...document });
  });
}

/** Removes everything kept about a project when the project goes. */
export async function forgetEngineProject(projectId: string): Promise<void> {
  const key = engineScopeKey(projectId);
  await serialized(choicesPath(), async () => {
    const document = await readDocument();
    delete document.choices[key];
    delete document.consents[key];
    await writeAtomic(choicesPath(), { version: 1, ...document });
  });
}

async function readSessions(): Promise<Record<string, EngineSessionRecord>> {
  const document = await readJson(sessionsPath());
  const raw = document.sessions;
  const out: Record<string, EngineSessionRecord> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.engine !== "string" || typeof record.sessionId !== "string" || typeof record.cwd !== "string") continue;
      out[key] = {
        engine: record.engine,
        sessionId: record.sessionId,
        cwd: record.cwd,
        briefKey: typeof record.briefKey === "string" ? record.briefKey : "",
        at: typeof record.at === "string" ? record.at : new Date(0).toISOString(),
      };
    }
  }
  return out;
}

export async function readEngineSession(chatId: string): Promise<EngineSessionRecord | null> {
  const sessions = await readSessions();
  return Object.prototype.hasOwnProperty.call(sessions, chatId) ? sessions[chatId] : null;
}

export async function writeEngineSession(chatId: string, record: EngineSessionRecord | null): Promise<void> {
  await serialized(sessionsPath(), async () => {
    const sessions = await readSessions();
    if (record) sessions[chatId] = record;
    else delete sessions[chatId];
    const entries = Object.entries(sessions);
    if (entries.length > MAX_SESSIONS) {
      entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [key] of entries.slice(0, entries.length - MAX_SESSIONS)) delete sessions[key];
    }
    await writeAtomic(sessionsPath(), { version: 1, sessions });
  });
}
