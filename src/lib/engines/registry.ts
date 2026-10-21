/**
 * The engines this process knows about.
 *
 * Core ships none. The application around it names a module in
 * EGGENT_ENGINES_MODULE; it is loaded once, handed `registerEngine`, and adds
 * whatever it can run. A deployment without that variable has an empty list,
 * which is what keeps the screens that mention engines out of the cloud and out
 * of a self-hosted install.
 *
 * The list lives on globalThis because routes and the boot hook are compiled
 * separately, and a module-level Map would be one copy per compiled module.
 */
import { pathToFileURL } from "node:url";
import type { Engine, EngineHostApi } from "@/lib/engines/host-types";
import type { EngineInfo, EngineModelInfo, EngineStatus } from "@/lib/engines/types";

const KEY = Symbol.for("eggent.engines");

/** A status is read by spawning programs, so a screen polling it is answered from here. */
const STATUS_TTL_MS = 20_000;

interface RegistryState {
  engines: Map<string, Engine>;
  loading: Promise<void> | null;
  loadError: string | null;
  cache: Map<string, { at: number; info: EngineInfo }>;
  inflight: Map<string, Promise<EngineInfo>>;
}

function state(): RegistryState {
  const holder = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  let current = holder[KEY];
  if (!current) {
    current = { engines: new Map(), loading: null, loadError: null, cache: new Map(), inflight: new Map() };
    holder[KEY] = current;
  }
  return current;
}

const ENGINE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function registerEngine(engine: Engine): void {
  if (!ENGINE_ID.test(engine.id)) throw new Error(`Engine id "${engine.id}" is not a short lowercase name.`);
  const current = state();
  current.engines.set(engine.id, engine);
  current.cache.delete(engine.id);
}

export function unregisterEngine(id: string): void {
  const current = state();
  current.engines.delete(id);
  current.cache.delete(id);
}

/** Forgets everything; for tests. */
export function resetEnginesForTest(): void {
  const holder = globalThis as unknown as Record<symbol, RegistryState | undefined>;
  holder[KEY] = undefined;
}

// A plain `import(path)` would be turned by the bundler into a lookup it cannot
// resolve; this is the native one.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

async function loadHostModule(file: string): Promise<void> {
  const loaded = (await nativeImport(pathToFileURL(file).href)) as {
    register?: unknown;
    default?: { register?: unknown } | unknown;
  };
  const candidate = typeof loaded.register === "function"
    ? loaded.register
    : typeof (loaded.default as { register?: unknown } | undefined)?.register === "function"
      ? (loaded.default as { register: unknown }).register
      : null;
  if (typeof candidate !== "function") {
    throw new Error("The engines module exports no register function.");
  }
  const api: EngineHostApi = { registerEngine };
  await (candidate as (api: EngineHostApi) => unknown)(api);
}

/** Loads the host's module once. A module that fails is logged and leaves the list as it is. */
export function ensureHostEngines(): Promise<void> {
  const current = state();
  if (current.loading) return current.loading;
  const file = process.env.EGGENT_ENGINES_MODULE?.trim();
  if (!file) {
    current.loading = Promise.resolve();
    return current.loading;
  }
  current.loading = loadHostModule(file).catch((error) => {
    current.loadError = error instanceof Error ? error.message : String(error);
    console.warn("[engines] could not load the host module:", current.loadError);
  });
  return current.loading;
}

export async function listEngines(): Promise<Engine[]> {
  await ensureHostEngines();
  return [...state().engines.values()];
}

export async function getEngine(id: string): Promise<Engine | undefined> {
  await ensureHostEngines();
  return state().engines.get(id);
}

export async function enginesAvailable(): Promise<boolean> {
  return (await listEngines()).length > 0;
}

export function enginesLoadError(): string | null {
  return state().loadError;
}

const DEFAULT_MODELS: EngineModelInfo[] = [{ id: "", label: "Default" }];

async function readInfo(engine: Engine): Promise<EngineInfo> {
  const [status, models] = await Promise.all([
    Promise.resolve()
      .then(() => engine.status())
      .catch((error): EngineStatus => ({
        state: "problem",
        code: "error",
        detail: error instanceof Error ? error.message : String(error),
      })),
    Promise.resolve()
      .then(() => engine.models())
      .then((list) => (Array.isArray(list) && list.length > 0 ? list : DEFAULT_MODELS))
      .catch(() => DEFAULT_MODELS),
  ]);
  return { id: engine.id, label: engine.label, models, status };
}

/** One engine's model list and status; `fresh` skips the short memory of the last answer. */
export async function engineInfo(id: string, options: { fresh?: boolean } = {}): Promise<EngineInfo | undefined> {
  const engine = await getEngine(id);
  if (!engine) return undefined;
  const current = state();
  const cached = current.cache.get(id);
  if (!options.fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.info;
  const pending = current.inflight.get(id);
  if (pending) return pending;
  const started = readInfo(engine)
    .then((info) => {
      current.cache.set(id, { at: Date.now(), info });
      return info;
    })
    .finally(() => {
      current.inflight.delete(id);
    });
  current.inflight.set(id, started);
  return started;
}

export async function listEngineInfos(options: { fresh?: boolean } = {}): Promise<EngineInfo[]> {
  const engines = await listEngines();
  const infos = await Promise.all(engines.map((engine) => engineInfo(engine.id, options)));
  return infos.filter((info): info is EngineInfo => Boolean(info));
}

/** Drops what is remembered about an engine, after a sign-in or a change the person made. */
export function forgetEngineStatus(id: string): void {
  state().cache.delete(id);
}
