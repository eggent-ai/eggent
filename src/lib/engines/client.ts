/**
 * What the screens do with engines, without any server code in it: ask which
 * programs this computer offers, set a project onto one, sign in, and the
 * words and shapes the two screens share.
 */
import type { EngineAccess, EngineChoice, EngineInfo, EngineModelInfo } from "@/lib/engines/types";
import { ORCHESTRATOR_ENGINE_KEY } from "@/lib/engines/types";

export interface EnginesResponse {
  available: boolean;
  engines: EngineInfo[];
  choice: EngineChoice | null;
  /** The programs already confirmed for this project, with the time of each yes. */
  consents: Record<string, string>;
}

export const NO_ENGINES: EnginesResponse = { available: false, engines: [], choice: null, consents: {} };

export function scopeOf(projectId: string | null | undefined): string {
  const id = typeof projectId === "string" ? projectId.trim() : "";
  return id || ORCHESTRATOR_ENGINE_KEY;
}

function isResponse(value: unknown): value is EnginesResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.available === "boolean" && Array.isArray(record.engines);
}

export async function loadEngines(projectId: string | null | undefined, options: { fresh?: boolean } = {}): Promise<EnginesResponse | null> {
  try {
    const query = `project=${encodeURIComponent(scopeOf(projectId))}${options.fresh ? "&fresh=1" : ""}`;
    const response = await fetch(`/api/engines?${query}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (!isResponse(body)) return null;
    return { ...NO_ENGINES, ...body, consents: body.consents ?? {} };
  } catch {
    return null;
  }
}

export type ChoiceBody = { engine: string | null; model?: string; access?: EngineAccess; confirm?: boolean };
export type ChoiceResult =
  | { ok: true; choice: EngineChoice | null }
  | { ok: false; code: "consent-required" | "model" | "engine" | "project" | "failed"; message?: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function saveEngineChoice(projectId: string | null | undefined, body: ChoiceBody): Promise<ChoiceResult> {
  try {
    const response = await fetch("/api/engines/choice", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ project: scopeOf(projectId), ...body }),
    });
    const json = (await response.json().catch(() => ({}))) as { choice?: EngineChoice | null; error?: string };
    if (response.ok) return { ok: true, choice: json.choice ?? null };
    const code = json.error === "consent-required" || json.error === "model" || json.error === "engine" || json.error === "project"
      ? json.error
      : "failed";
    return { ok: false, code, message: typeof json.error === "string" ? json.error : undefined };
  } catch (error) {
    return { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function startEngineSignIn(engineId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/engines/${encodeURIComponent(engineId)}/login`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function cancelEngineSignIn(engineId: string): Promise<void> {
  try {
    await fetch(`/api/engines/${encodeURIComponent(engineId)}/login`, { method: "DELETE", headers: JSON_HEADERS, body: "{}" });
  } catch {
    // The status poll shows how it ended.
  }
}

export interface ProbeOutcome {
  ok: boolean;
  text?: string;
  error?: { code: string; message: string };
}

export async function probeEngineRun(engineId: string, model: string): Promise<ProbeOutcome> {
  try {
    const response = await fetch(`/api/engines/${encodeURIComponent(engineId)}/probe`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model }),
    });
    const json = (await response.json().catch(() => ({}))) as ProbeOutcome & { error?: unknown };
    if (!response.ok) return { ok: false, error: { code: "failed", message: typeof json.error === "string" ? json.error : `HTTP ${response.status}` } };
    return json;
  } catch (error) {
    return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** Programs worth showing: one that is not on this computer at all is not offered. */
export function visibleEngines(response: EnginesResponse | null): EngineInfo[] {
  return (response?.engines ?? []).filter((engine) => engine.status.state !== "not-installed");
}

/** The model an id stands for, or the engine's first (its default) for the empty id and for one it no longer lists. */
export function engineModel(info: EngineInfo, modelId: string): EngineModelInfo {
  return info.models.find((model) => model.id === modelId) ?? info.models[0] ?? { id: "", label: "" };
}

/** "Claude Code", or "Claude Code · Opus" when the project names a model of its own. */
export function engineChoiceLabel(info: EngineInfo, choice: Pick<EngineChoice, "model">): string {
  const model = choice.model ? engineModel(info, choice.model) : null;
  return model && model.id ? `${info.label} · ${model.label}` : info.label;
}

/** The fullest window of the subscription, for a line that cannot show them all. */
export function busiestWindow(info: EngineInfo): { label: string; percent: number } | null {
  const windows = info.status.limits ?? [];
  if (windows.length === 0) return null;
  const top = windows.reduce((best, current) => (current.used > best.used ? current : best));
  return { label: top.label, percent: Math.round(Math.min(1, Math.max(0, top.used)) * 100) };
}
