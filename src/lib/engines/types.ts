/**
 * Engines: programs installed on the person's own computer that can carry out a
 * chat's turns in place of a model - a coding agent run as a child process.
 *
 * Core knows nothing about which ones exist. The application that embeds core
 * registers them (see registry.ts), and a deployment without such an
 * application has none, so every screen that mentions engines stays out of
 * sight there. Nothing in this file imports Node, so the screens share it.
 */

/** How far an engine may reach: the project's folder, or the whole machine as in a terminal. */
export type EngineAccess = "project" | "full";

export const ENGINE_ACCESS_LEVELS: readonly EngineAccess[] = ["project", "full"];

export function isEngineAccess(value: unknown): value is EngineAccess {
  return value === "project" || value === "full";
}

export interface EngineModelInfo {
  id: string;
  label: string;
}

export type EngineState = "ready" | "signed-out" | "not-installed" | "problem";

/** What a screen says for a problem, in its own words: the host only names the code. */
export type EngineProblemCode = "api-key" | "old-version" | "limit" | "error";

/** One window of a subscription's limits, as the program reports it. */
export interface EngineLimitWindow {
  id: string;
  label: string;
  /** 0..1, how much of the window is used. */
  used: number;
  /** Unix seconds. */
  resetsAt?: number;
}

export interface EngineStatus {
  state: EngineState;
  version?: string;
  /** The plan the person signed in with, as the program names it ("Max"). Never an address. */
  account?: string;
  limits?: EngineLimitWindow[];
  code?: EngineProblemCode;
  /** A short English sentence from the host, for logs and for codes the screen does not know. */
  detail?: string;
}

export interface EngineInfo {
  id: string;
  label: string;
  /** The first one is the engine's default. */
  models: EngineModelInfo[];
  status: EngineStatus;
}

/** What a project (or the orchestrator) is set to run on, kept per computer. */
export interface EngineChoice {
  engine: string;
  /** An id from the engine's model list; empty means the engine's default. */
  model: string;
  access: EngineAccess;
  /** When the person confirmed the first-use sheet for this project. */
  consentAt?: string;
}

/** The provider id an engine's models are registered under for a session. */
export const ENGINE_PROVIDER_PREFIX = "engine-";

export function engineProviderId(engineId: string): string {
  return `${ENGINE_PROVIDER_PREFIX}${engineId}`;
}

export function isEngineProviderId(providerId: unknown): providerId is string {
  return typeof providerId === "string" && providerId.startsWith(ENGINE_PROVIDER_PREFIX);
}

/** The key a choice is kept under: the project's id, or "none" for the orchestrator. */
export const ORCHESTRATOR_ENGINE_KEY = "none";

export function engineScopeKey(projectId: string | null | undefined): string {
  const id = typeof projectId === "string" ? projectId.trim() : "";
  return id && id !== ORCHESTRATOR_ENGINE_KEY ? id : ORCHESTRATOR_ENGINE_KEY;
}

/** The tool a session on an engine hands each request to. */
export const ENGINE_TOOL_NAME = "engine_run";
