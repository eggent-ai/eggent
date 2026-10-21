/**
 * What the engine routes do, kept out of the routes so a test can drive it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineLogin, EngineRunResult } from "@/lib/engines/host-types";
import { forgetEngineLimit } from "@/lib/engines/limits";
import { engineInfo, forgetEngineStatus, getEngine, listEngineInfos } from "@/lib/engines/registry";
import { forgetEngineModels } from "@/lib/engines/resolve";
import { readEngineChoice, readEngineConsents, writeEngineChoice } from "@/lib/engines/store";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { isEngineAccess, ORCHESTRATOR_ENGINE_KEY, type EngineChoice, type EngineInfo } from "@/lib/engines/types";
import { getProject } from "@/lib/storage/project-store";

export interface EnginesState {
  /** False where nothing registered an engine: the screens then show nothing at all. */
  available: boolean;
  engines: EngineInfo[];
  /** What this project (or the orchestrator) is set to, if anything. */
  choice: EngineChoice | null;
  /** The programs the person has already confirmed for it, with the time: turning one on again needs no sheet. */
  consents: Record<string, string>;
}

const LOGINS_KEY = Symbol.for("eggent.engines.logins");

function logins(): Map<string, EngineLogin> {
  const holder = globalThis as unknown as Record<symbol, Map<string, EngineLogin> | undefined>;
  return (holder[LOGINS_KEY] ??= new Map());
}

export function normalizeScope(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text !== ORCHESTRATOR_ENGINE_KEY ? text : null;
}

export async function engineState(projectId: string | null, options: { fresh?: boolean } = {}): Promise<EnginesState> {
  const engines = (await listEngineInfos(options)).map((info) => ({
    ...info,
    ...(logins().has(info.id) ? { loggingIn: true } : {}),
  }));
  return {
    available: engines.length > 0,
    engines,
    choice: await readEngineChoice(projectId),
    consents: await readEngineConsents(projectId),
  };
}

export type ChoiceInput = {
  engine: string | null;
  model?: unknown;
  access?: unknown;
  /** The person confirmed the first-use sheet. */
  confirm?: boolean;
};

export type ChoiceOutcome =
  | { ok: true; choice: EngineChoice | null }
  | { ok: false; status: number; code: "project" | "engine" | "model" | "consent-required" };

export async function applyEngineChoice(projectId: string | null, input: ChoiceInput): Promise<ChoiceOutcome> {
  if (projectId && !(await getProject(projectId).catch(() => null))) return { ok: false, status: 404, code: "project" };
  if (input.engine === null) {
    await writeEngineChoice(projectId, null);
    announceChange(projectId);
    return { ok: true, choice: null };
  }
  const engine = await getEngine(input.engine);
  if (!engine) return { ok: false, status: 404, code: "engine" };
  const models = await Promise.resolve(engine.models()).catch(() => []);
  const existing = await readEngineChoice(projectId);
  const sameEngine = existing?.engine === engine.id;
  // A request that says nothing about the model leaves a project's model as it was;
  // an empty one asks for the program's own default.
  const model = typeof input.model === "string" ? input.model.trim() : sameEngine && existing ? existing.model : "";
  if (model && !models.some((candidate) => candidate.id === model)) return { ok: false, status: 400, code: "model" };
  const consentAt = (sameEngine && existing?.consentAt)
    || (await readEngineConsents(projectId))[engine.id]
    || (input.confirm === true ? new Date().toISOString() : undefined);
  if (!consentAt) return { ok: false, status: 409, code: "consent-required" };
  const access = isEngineAccess(input.access) ? input.access : sameEngine && existing ? existing.access : "project";
  const choice: EngineChoice = { engine: engine.id, model, access, consentAt };
  await writeEngineChoice(projectId, choice);
  announceChange(projectId);
  return { ok: true, choice };
}

/** The open chats re-read what answers them: the label under the composer, and the note about the mode. */
function announceChange(projectId: string | null): void {
  publishUiSyncEvent({ topic: "projects", projectId, reason: "engine_changed" });
}

/** Starts the program's own sign-in, which opens the browser; the screen then watches the status. */
export async function startEngineLogin(engineId: string): Promise<"started" | "running" | "unknown"> {
  const engine = await getEngine(engineId);
  if (!engine) return "unknown";
  if (logins().has(engineId)) return "running";
  const login = await engine.startLogin();
  logins().set(engineId, login);
  void login.done
    .catch(() => undefined)
    .finally(() => {
      if (logins().get(engineId) === login) logins().delete(engineId);
      forgetEngineStatus(engineId);
      forgetEngineModels(engineId);
      // Signed in again, perhaps to another plan: a limit noticed before no longer holds.
      forgetEngineLimit(engineId);
    });
  return "started";
}

export function cancelEngineLogin(engineId: string): boolean {
  const login = logins().get(engineId);
  if (!login) return false;
  login.cancel();
  logins().delete(engineId);
  forgetEngineStatus(engineId);
  return true;
}

function probeTimeoutMs(): number {
  const parsed = Number(process.env.EGGENT_ENGINE_PROBE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}

/**
 * A request small enough to cost next to nothing, to find out that the program
 * answers before a project is moved onto it. It runs in an empty folder and
 * leaves no session of the program's own behind.
 */
export async function probeEngine(engineId: string, model: string): Promise<EngineRunResult | null> {
  const engine = await getEngine(engineId);
  if (!engine) return null;
  const info = await engineInfo(engineId, { fresh: true });
  if (info && info.status.state !== "ready") {
    const code = info.status.state === "not-installed" ? "not-installed" : info.status.state === "signed-out" ? "signed-out" : "failed";
    return { ok: false, text: "", error: { code, message: info.status.detail ?? info.status.state } };
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-engine-probe-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), probeTimeoutMs());
  try {
    const result = await engine.run({
      prompt: "Reply with the single word OK.",
      brief: "",
      recap: "",
      cwd: folder,
      sessionId: null,
      model,
      access: "project",
      ephemeral: true,
      signal: controller.signal,
      onEvent: () => {},
    });
    return controller.signal.aborted && !result.ok
      ? { ok: false, text: "", error: { code: "timeout", message: "No answer in time." } }
      : result;
  } finally {
    clearTimeout(timer);
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
