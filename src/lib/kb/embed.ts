import { getManagedGatewayToken } from "@/lib/pi/config-store";
import { managedGatewayBaseUrl } from "@/lib/pi/managed-models";
import { embedTexts } from "@/lib/memory/embeddings";
import { getSettings } from "@/lib/storage/settings-store";

/**
 * Meaning for the search over a shared project, when this workspace has a way
 * to compute it.
 *
 * In order: the deployment's gateway, which takes the workspace's own gateway
 * credential and decides the model itself, so the request names none and every
 * index on one deployment has one width; else the embeddings model the person
 * set up in Settings, when they gave it a key or an address; else nothing, and
 * the search finds words without meaning. Nothing here ever fails a search: an
 * embedder that refuses is set aside for a while and the words still answer.
 */

export interface KbEmbedder {
  /** Names the model, so vectors made by another one are never compared with these. */
  id: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

const BATCH = 64;
const TIMEOUT_MS = 60_000;
const COOLDOWN_MS = 5 * 60_000;

interface CooldownHolder {
  __eggentKbEmbedCooldown?: Map<string, number>;
}

function cooldowns(): Map<string, number> {
  const holder = globalThis as unknown as CooldownHolder;
  return (holder.__eggentKbEmbedCooldown ??= new Map());
}

/** Set an embedder aside after it refused, so each search does not wait on it again. */
export function kbEmbedderFailed(id: string): void {
  cooldowns().set(id, Date.now() + COOLDOWN_MS);
}

function resting(id: string): boolean {
  const until = cooldowns().get(id);
  if (!until) return false;
  if (until > Date.now()) return true;
  cooldowns().delete(id);
  return false;
}

async function inBatches(texts: string[], one: (batch: string[]) => Promise<number[][]>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let at = 0; at < texts.length; at += BATCH) {
    const vectors = await one(texts.slice(at, at + BATCH));
    if (vectors.length !== Math.min(BATCH, texts.length - at)) throw new Error("The embeddings answer has the wrong number of rows.");
    for (const vector of vectors) out.push(Float32Array.from(vector));
  }
  const width = out[0]?.length ?? 0;
  if (out.some((vector) => vector.length !== width || width === 0)) throw new Error("The embeddings answer has rows of different widths.");
  return out;
}

function gatewayEmbedder(baseUrl: string, token: string): KbEmbedder {
  return {
    id: `gateway:${baseUrl}`,
    embed: (texts, signal) =>
      inBatches(texts, async (batch) => {
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ input: batch }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Embeddings answered ${response.status}.`);
        const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
        const rows = Array.isArray(payload.data) ? [...payload.data] : [];
        rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return rows.map((row) => {
          if (!Array.isArray(row.embedding)) throw new Error("An embeddings row is not a list of numbers.");
          return row.embedding as number[];
        });
      }),
  };
}

/** The embedder this workspace can use now, or null for a search by words only. */
export async function kbEmbedder(): Promise<KbEmbedder | null> {
  const baseUrl = managedGatewayBaseUrl();
  const token = baseUrl ? await getManagedGatewayToken().catch(() => "") : "";
  if (baseUrl && token) {
    const gateway = gatewayEmbedder(baseUrl, token);
    if (!resting(gateway.id)) return gateway;
  }
  const settings = await getSettings().catch(() => null);
  const config = settings?.embeddingsModel;
  // The default settings name a model with no key: nothing the person set up.
  if (!config?.model || config.provider === "mock" || !(config.apiKey || config.baseUrl)) return null;
  const id = `settings:${config.provider}:${config.model}:${config.baseUrl || ""}:${config.dimensions || ""}`;
  if (resting(id)) return null;
  return {
    id,
    embed: (texts) => inBatches(texts, (batch) => embedTexts(batch, config)),
  };
}
