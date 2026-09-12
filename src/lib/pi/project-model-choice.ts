/**
 * A project's own model, as the settings form sees it and as model.json keeps it.
 *
 * The runtime (session.ts, getResolvedPiRuntimeModel) gives a project its own
 * model only when `inheritsGlobal` is not true and the provider/model pair is
 * one the workspace can serve right now; anything else answers with the
 * workspace model and says nothing about it. The form has to show both halves
 * of that rule, so reading the file and applying the rule live here, next to
 * each other and away from anything server-side, where a test can reach them.
 */

export type ProjectModelMode = "workspace" | "project";

export interface ProjectModelChoice {
  mode: ProjectModelMode;
  provider: string;
  model: string;
}

export interface ParsedProjectModelFile {
  choice: ProjectModelChoice;
  /** Keys the form does not own. A save carries them through untouched. */
  extra: Record<string, unknown>;
  /** False when the file is not a JSON object; the form then starts from the workspace model. */
  readable: boolean;
}

/** The slice of GET /api/pi/models the project form reads. */
export interface ProjectModelsState {
  providers?: Array<{ id: string; name?: string }>;
  availableModels?: Array<{ provider: string; id: string; name?: string }>;
  managed?: { providerId?: string | null; label?: string };
  modelLock?: { locked?: boolean; label?: string };
  current?: {
    provider?: string;
    providerName?: string;
    model?: { id: string; available?: boolean };
  } | null;
  /** What the workspace answers with, which is the saved model only while it is servable. */
  runtimeModel?: {
    provider?: string;
    providerName?: string;
    model?: { id: string; name?: string };
  } | null;
}

export interface ProjectProviderOption {
  id: string;
  name: string;
  /** The included model: shown under its label, never by the model behind it. */
  managed: boolean;
}

const OWNED_KEYS = new Set(["inheritsGlobal", "provider", "model"]);
const MANAGED_FALLBACK_ID = "eggent-ai";
const MANAGED_FALLBACK_LABEL = "Eggent AI";

export function parseProjectModelFile(content: string): ParsedProjectModelFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim() || "{}");
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { choice: { mode: "workspace", provider: "", model: "" }, extra: {}, readable: false };
  }
  const record = parsed as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  // The runtime's own test, including its quiet case: false with no provider
  // and model answers with the workspace model.
  const mode: ProjectModelMode = record.inheritsGlobal !== true && provider && model ? "project" : "workspace";
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !OWNED_KEYS.has(key)));
  // A remembered provider and model stay in the choice even while the file
  // follows the workspace, so switching back starts from the last pick.
  return { choice: { mode, provider, model }, extra, readable: true };
}

export function serializeProjectModelFile(choice: ProjectModelChoice, extra: Record<string, unknown> = {}): string {
  const owned = choice.mode === "project"
    ? { inheritsGlobal: false, provider: choice.provider, model: choice.model }
    : { inheritsGlobal: true };
  return JSON.stringify({ ...owned, ...extra }, null, 2);
}

export function sameProjectModelChoice(a: ProjectModelChoice, b: ProjectModelChoice): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode === "workspace" || (a.provider === b.provider && a.model === b.model);
}

/** A choice that can be saved: following the workspace, or a provider and a model. */
export function projectModelChoiceComplete(choice: ProjectModelChoice): boolean {
  return choice.mode === "workspace" || Boolean(choice.provider && choice.model);
}

export function managedProviderId(state: ProjectModelsState): string {
  return state.managed?.providerId || MANAGED_FALLBACK_ID;
}

/** Providers that can answer right now, the included model last and under its label. */
export function projectProviderOptions(state: ProjectModelsState): ProjectProviderOption[] {
  const managedId = managedProviderId(state);
  const servable = new Set((state.availableModels ?? []).map((model) => model.provider));
  const own = (state.providers ?? [])
    .filter((provider) => provider.id !== managedId && servable.has(provider.id))
    .map((provider) => ({ id: provider.id, name: provider.name || provider.id, managed: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Offered only when it can answer now - a credential the runtime can serve,
  // not merely one the workspace could recover - because a choice the runtime
  // cannot serve silently becomes the workspace model.
  if (!servable.has(managedId)) return own;
  return [...own, { id: managedId, name: state.managed?.label || MANAGED_FALLBACK_LABEL, managed: true }];
}

export function projectModelOptions(state: ProjectModelsState, provider: string): Array<{ id: string; name?: string }> {
  return (state.availableModels ?? [])
    .filter((model) => model.provider === provider)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether the runtime would use this choice now, rather than fall back to the workspace model. */
export function projectModelChoiceServable(state: ProjectModelsState, choice: ProjectModelChoice): boolean {
  if (choice.mode !== "project") return true;
  return (state.availableModels ?? []).some((model) => model.provider === choice.provider && model.id === choice.model);
}

/** What "the workspace model" means right now, or null when the workspace has none. */
export function workspaceModelSummary(state: ProjectModelsState): { provider: string; model?: string } | null {
  if (state.modelLock?.locked) return { provider: state.modelLock.label || MANAGED_FALLBACK_LABEL };
  // What answers, not what is written down: a saved model the workspace cannot
  // serve is answered by another one, and saying nothing at all reads as "no
  // model selected" to somebody who selected one.
  const runtime = state.runtimeModel;
  if (runtime?.model?.id) {
    return { provider: runtime.providerName || runtime.provider || runtime.model.id, model: runtime.model.id };
  }
  const current = state.current;
  if (!current?.provider || !current.model?.available) return null;
  return { provider: current.providerName || current.provider, model: current.model.id };
}
