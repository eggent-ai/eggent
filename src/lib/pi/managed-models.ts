/**
 * Which models the included Eggent AI plan can answer with.
 *
 * The workspace does not decide this and cannot: the models on offer, and what
 * each one costs, are the deployment's to set, and only the gateway knows both.
 * So the list is fetched from it rather than compiled in, which is what lets a
 * model be added, repriced or withdrawn without a new image reaching the fleet.
 *
 * Two rules the model catalog work already paid for apply here too. The list is
 * cached on disk and refreshed away from the request path, because a runtime
 * built for a chat turn must never wait on a fetch. And a workspace that cannot
 * reach the gateway keeps working on whatever it last knew - an empty list here
 * would mean a workspace with a valid credential and no model to run it on.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type ManagedModelKind = "text" | "image" | "embedding";

export interface ManagedCatalogPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  currency: string;
}

export interface ManagedCatalogModel {
  id: string;
  name: string;
  /** The heading this model sits under in the picker, when the deployment sets one. */
  family?: string;
  kind: ManagedModelKind;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  input: Array<"text" | "image">;
  reasoning: boolean;
  default: boolean;
  /** False when the deployment publishes no cached-input rate for this model. */
  cached: boolean;
  price?: ManagedCatalogPrice;
}

interface ManagedCatalogCache {
  fetchedAt: string;
  models: ManagedCatalogModel[];
}

/** What the included model is described as when the gateway says nothing. */
export const MANAGED_MODEL_CONTEXT_WINDOW = 272000;
export const MANAGED_MODEL_MAX_TOKENS = 128000;

/**
 * Where the cached list lives.
 *
 * The agent directory is resolved through a lazy import on purpose: reading it
 * eagerly would pull the whole runtime SDK into this module, and the rules
 * above - what a payload means, which model is the default - have to stay
 * reachable without it. The same reason src/lib/types.ts is type-only.
 */
export async function getManagedCatalogPath(): Promise<string> {
  const { getPiAgentDir } = await import("@/lib/pi/config-store");
  return path.join(getPiAgentDir(), "eggent-ai-models.json");
}

/**
 * Where the included model is served from.
 *
 * The same derivation the credential repair uses: stated outright when the
 * deployment says so, otherwise taken from the usage endpoint, which sits on
 * the same host and which every managed workspace already carries - so this
 * works on workspaces provisioned before the explicit variable existed.
 */
export function managedGatewayBaseUrl(): string | null {
  const explicit = process.env.EGGENT_AI_MODEL_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const usage = process.env.EGGENT_USAGE_API_URL?.trim();
  if (!usage) return null;
  try {
    return `${new URL(usage).origin}/v1`;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parsePrice(value: unknown): ManagedCatalogPrice | undefined {
  if (!isRecord(value)) return undefined;
  const input = Number(value.input);
  const output = Number(value.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  const cacheRead = Number(value.cacheRead);
  const cacheWrite = Number(value.cacheWrite);
  return {
    input,
    output,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : input,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : input,
    currency: typeof value.currency === "string" ? value.currency : "",
  };
}

/**
 * Read the gateway's answer into our own shape.
 *
 * Every field is taken explicitly and anything unrecognised is dropped, the
 * same rule the usage snapshot follows: this document comes over the network
 * and is written straight into the file the runtime resolves models from.
 */
export function parseManagedCatalogPayload(payload: unknown): ManagedCatalogModel[] {
  const data = isRecord(payload) ? payload.data : null;
  if (!Array.isArray(data)) return [];
  const models: ManagedCatalogModel[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    const extra = isRecord(row.eggent) ? row.eggent : {};
    const kind = extra.kind === "image" || extra.kind === "embedding" ? extra.kind : "text";
    const inputModalities = Array.isArray(extra.input)
      ? extra.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
      : [];
    models.push({
      id,
      name: typeof extra.name === "string" && extra.name.trim() ? extra.name.trim() : id,
      family: typeof extra.family === "string" && extra.family.trim() ? extra.family.trim() : undefined,
      kind,
      description: typeof extra.description === "string" ? extra.description : undefined,
      contextWindow: positiveInteger(extra.context_window),
      maxTokens: positiveInteger(extra.max_tokens),
      input: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoning: extra.reasoning === true,
      default: extra.default === true,
      // Absent means the deployment said nothing, and the safe reading is that
      // there is a cache tier - the same as before this field existed.
      cached: extra.cached !== false,
      price: parsePrice(extra.price),
    });
  }
  return models;
}

export async function readManagedCatalog(): Promise<ManagedCatalogModel[]> {
  try {
    const raw = await fs.readFile(await getManagedCatalogPath(), "utf-8");
    const parsed = JSON.parse(raw) as ManagedCatalogCache;
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/** The models a chat can be set to. Images and embeddings are routed elsewhere
 * and would break a conversation if somebody picked one as their chat model. */
export async function readManagedTextCatalog(): Promise<ManagedCatalogModel[]> {
  return (await readManagedCatalog()).filter((model) => model.kind === "text");
}

export function managedDefaultTextModel(models: ManagedCatalogModel[]): ManagedCatalogModel | undefined {
  const text = models.filter((model) => model.kind === "text");
  return text.find((model) => model.default) || text[0];
}

async function writeManagedCatalog(models: ManagedCatalogModel[]): Promise<void> {
  const filePath = await getManagedCatalogPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const cache: ManagedCatalogCache = { fetchedAt: new Date().toISOString(), models };
  await fs.writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
}

/**
 * Ask the gateway what it serves and remember the answer.
 *
 * Called from instrumentation at boot and on a timer, never from a request.
 * An empty or unreadable answer leaves the previous list alone: losing the
 * catalog is worse than holding a slightly old one, because the workspace
 * resolves its chat model out of it.
 */
export async function refreshManagedCatalog(token: string): Promise<{ models: number }> {
  const baseUrl = managedGatewayBaseUrl();
  if (!baseUrl || !token) return { models: 0 };
  const response = await fetch(new URL(`${baseUrl.replace(/\/+$/, "")}/models`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Eggent AI model list failed (${response.status}).`);
  }
  const models = parseManagedCatalogPayload(await response.json());
  if (models.length === 0) return { models: 0 };
  await writeManagedCatalog(models);
  return { models: models.length };
}
