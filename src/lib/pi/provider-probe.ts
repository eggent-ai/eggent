/**
 * Asking a model provider what is wrong with it.
 *
 * A turn that produces zero tokens looks the same from the inside whatever
 * caused it — a dead address, a rejected key, a model id the provider does not
 * have. Telling someone "maybe rate limits, maybe quota, maybe the key" leaves
 * them to try all three, so these helpers go and find out instead.
 *
 * Deliberately dependency-free: it is called from the chat error path, where
 * pulling in the model runtime to explain a failure would be its own risk.
 */

export type ProviderProbeReason =
  | "ok"
  | "unreachable"
  | "unauthorized"
  | "model_missing"
  | "http_error"
  | "not_checked";

export interface ProviderProbe {
  ok: boolean;
  reason: ProviderProbeReason;
  status?: number;
  detail?: string;
  /** Model ids the endpoint reported, when it reported any. */
  models?: string[];
  /**
   * True when the list said, for at least one model, what it accepts as input.
   * Many OpenAI-compatible lists carry ids only, and silence there is not a "no".
   */
  describesInputs?: boolean;
  /** Ids from the whole list (not only the first 20) that accept pictures. */
  imageModels?: string[];
}

/**
 * What one entry of a model list says about pictures: true, false, or nothing.
 *
 * OpenRouter and the resellers built on it put this under `architecture`
 * (`input_modalities`, or a `text+image->text` modality string); other servers
 * use a flat `input_modalities`, `modalities.input` or a vision flag.
 */
export function entryAcceptsImages(item: unknown): boolean | undefined {
  if (!item || typeof item !== "object") return undefined;
  const entry = item as Record<string, unknown>;
  const architecture = entry.architecture && typeof entry.architecture === "object"
    ? entry.architecture as Record<string, unknown>
    : undefined;
  const modalities = entry.modalities && typeof entry.modalities === "object"
    ? entry.modalities as Record<string, unknown>
    : undefined;
  for (const list of [architecture?.input_modalities, entry.input_modalities, modalities?.input]) {
    if (Array.isArray(list)) return list.some((value) => String(value).toLowerCase() === "image");
  }
  if (typeof architecture?.modality === "string" && architecture.modality.includes("->")) {
    return architecture.modality.split("->")[0].split("+").some((value) => value.trim().toLowerCase() === "image");
  }
  const capabilities = entry.capabilities && typeof entry.capabilities === "object"
    ? entry.capabilities as Record<string, unknown>
    : undefined;
  for (const flag of [capabilities?.vision, entry.supports_vision, entry.vision, entry.supports_image_input]) {
    if (typeof flag === "boolean") return flag;
  }
  return undefined;
}

/**
 * True when the address only resolves on the machine Eggent itself runs on.
 *
 * People point a workspace at the LM Studio or Ollama running on their laptop,
 * which is right for a self-hosted Eggent and impossible for a hosted one: the
 * loopback address belongs to the container. Accepting it without a word means
 * the first message they ever send comes back as an error.
 */
export function isLocalOnlyBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Provider APIs this check understands.
 *
 * The probe speaks one dialect: GET {baseUrl}/models with a bearer token. That
 * covers the OpenAI-compatible endpoints, which is what a custom provider
 * almost always is, and nothing else. Anthropic authenticates with x-api-key,
 * Google puts the key in the query string, Vertex and Bedrock use cloud
 * credentials entirely — probing those the OpenAI way returns 401 for a key
 * that is perfectly good, and a confidently wrong diagnosis is worse than the
 * vague one it replaced. Anything not listed here is left unchecked.
 */
const PROBEABLE_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses"]);

export function canProbeProviderApi(api?: string): boolean {
  return PROBEABLE_APIS.has((api || "openai-completions").trim().toLowerCase());
}

/**
 * One call to the provider's own model list, classified.
 *
 * A 401 proves the endpoint is alive as surely as a 200 does, which is what
 * makes this worth doing without any credential at all.
 */
export async function probeModelProvider(params: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<ProviderProbe> {
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, reason: "not_checked" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized", status: response.status };
    }
    if (!response.ok) {
      return { ok: false, reason: "http_error", status: response.status };
    }

    let ids: string[] = [];
    let describesInputs = false;
    const imageModels: string[] = [];
    try {
      const body = (await response.json()) as { data?: unknown; models?: unknown };
      const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      for (const item of list) {
        const id = typeof item === "string" ? item : (item as { id?: unknown })?.id;
        if (typeof id !== "string" || !id) continue;
        ids.push(id);
        const images = entryAcceptsImages(item);
        if (images !== undefined) describesInputs = true;
        if (images) imageModels.push(id);
      }
    } catch {
      // A provider that answers 200 with something we cannot parse has still
      // proved the endpoint and the key, which is what we came to find out.
      return { ok: true, reason: "ok", status: response.status };
    }

    const inputs = describesInputs ? { describesInputs, imageModels } : {};
    if (params.model && ids.length > 0 && !ids.includes(params.model)) {
      return { ok: false, reason: "model_missing", status: response.status, models: ids.slice(0, 20), ...inputs };
    }
    return { ok: true, reason: "ok", status: response.status, models: ids.slice(0, 20), ...inputs };
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
