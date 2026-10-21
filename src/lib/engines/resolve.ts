/**
 * Which engine, if any, a project's turns run on - one function that every
 * caller (the session, the label under the composer, a turn handed over from
 * the cloud) asks, so none of them can report one thing while another runs.
 */
import type { Engine } from "@/lib/engines/host-types";
import { engineInfo, getEngine } from "@/lib/engines/registry";
import { readEngineChoice } from "@/lib/engines/store";
import type { EngineChoice, EngineInfo, EngineModelInfo } from "@/lib/engines/types";

export interface EngineRun {
  engine: Engine;
  choice: EngineChoice;
  /** The model the choice names, or the engine's first when it names none the engine has. */
  model: EngineModelInfo;
  models: EngineModelInfo[];
}

/** Null when the project is on a model, which is nearly always. */
export async function resolveEngineRun(projectId: string | null | undefined): Promise<EngineRun | null> {
  const choice = await readEngineChoice(projectId);
  if (!choice) return null;
  const engine = await getEngine(choice.engine);
  if (!engine) return null;
  const info = await modelsOf(engine);
  const model = info.find((candidate) => candidate.id === choice.model) ?? info[0];
  return { engine, choice, model, models: info };
}

const MODELS_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; models: EngineModelInfo[] }>();

async function modelsOf(engine: Engine): Promise<EngineModelInfo[]> {
  const cached = modelCache.get(engine.id);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  let models: EngineModelInfo[];
  try {
    const listed = await engine.models();
    models = Array.isArray(listed) && listed.length > 0 ? listed : [{ id: "", label: "Default" }];
  } catch {
    models = [{ id: "", label: "Default" }];
  }
  modelCache.set(engine.id, { at: Date.now(), models });
  return models;
}

export function forgetEngineModels(engineId?: string): void {
  if (engineId) modelCache.delete(engineId);
  else modelCache.clear();
}

/** Why a turn on this engine cannot start right now, or null when it can. */
export async function engineNotReady(run: EngineRun): Promise<EngineInfo["status"] | null> {
  const info = await engineInfo(run.engine.id);
  if (!info) return { state: "not-installed" };
  return info.status.state === "ready" ? null : info.status;
}
