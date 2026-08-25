import "@/lib/pi/env";
import fs from "fs/promises";
import path from "path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeStats } from "@/lib/pi/types";
import { getWorkDir, loadProjectModelSettings } from "@/lib/storage/project-store";
import { canProbeProviderApi, isLocalOnlyBaseUrl, probeModelProvider, type ProviderProbe } from "@/lib/pi/provider-probe";

type StoredCredentialInfo = { providerId: string; type: string };
type StoredCredentialRecord = { type: string; key?: string; env?: Record<string, string> };

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function eggentAiModelLabel(): string {
  return process.env.EGGENT_AI_MODEL_LABEL?.trim() || "Eggent AI";
}

function getPiSdkExport<T = unknown>(name: string): T {
  const sdk = PiSdk as unknown as Record<string, unknown> & { default?: Record<string, unknown> };
  const value = sdk[name] ?? sdk.default?.[name];
  if (!value) {
    throw new Error(`Eggent runtime SDK export "${name}" is unavailable. Rebuild the Docker image with the current dependencies.`);
  }
  return value as T;
}

export function getPiAgentDir(): string {
  const getAgentDir = (PiSdk as unknown as { getAgentDir?: () => string; default?: { getAgentDir?: () => string } }).getAgentDir
    ?? (PiSdk as unknown as { default?: { getAgentDir?: () => string } }).default?.getAgentDir;
  if (typeof getAgentDir === "function") {
    return getAgentDir();
  }
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(process.cwd(), "data", "pi-agent");
}

export function getPiAuthPath(): string {
  return path.join(getPiAgentDir(), "auth.json");
}

export function getPiModelsPath(): string {
  return path.join(getPiAgentDir(), "models.json");
}

function getEggentAiLockOverridePath(): string {
  return path.join(getPiAgentDir(), "eggent-ai-lock.json");
}

let webSearchWorkflowEnsured = false;

/**
 * Keep pi-web-access out of its interactive "search curator" mode.
 *
 * The curator streams results into a browser window it opens itself. Eggent
 * serves a web UI and registers a UI context for MCP prompts, so the extension
 * believes a terminal user is present, tries to open a browser that does not
 * exist, and the failure path throws instead of falling back — surfacing
 * `sendCuratorFallbackUpdate is not defined` to the user in place of results.
 *
 * Pinning the workflow to "none" resolves it before that branch is reached. Only
 * the workflow key is written, so provider API keys in the same file survive.
 */
export async function ensureWebSearchWorkflow(): Promise<void> {
  if (webSearchWorkflowEnsured) return;
  webSearchWorkflowEnsured = true;

  const configPath = path.join(getPiAgentDir(), "web-search.json");
  try {
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or unreadable config: start from an empty one.
    }

    if (config.workflow === "none") return;
    config.workflow = "none";
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  } catch (error) {
    // Web search still works without this; never block a run over it.
    console.warn("[eggent] Could not pin the web search workflow:", error instanceof Error ? error.message : error);
    webSearchWorkflowEnsured = false;
  }
}

async function readEggentAiLockOverride(): Promise<{ disabled?: boolean }> {
  try {
    const content = await fs.readFile(getEggentAiLockOverridePath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as { disabled?: boolean }
      : {};
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}

/** Back to the default state: no override file rather than an empty one. */
async function removeEggentAiLockOverride(): Promise<void> {
  await fs.rm(getEggentAiLockOverridePath(), { force: true });
}

async function writeEggentAiLockOverride(content: { disabled?: boolean }): Promise<void> {
  const filePath = getEggentAiLockOverridePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readAuthJson(): Promise<Record<string, StoredCredentialRecord>> {
  try {
    const content = await fs.readFile(getPiAuthPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, StoredCredentialRecord>
      : {};
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
}

function readJsonRecord(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

export interface ImageGenerationState {
  enabled: boolean;
  provider: "eggent" | "custom" | "none";
  label: string;
  providerId?: string;
  model?: string;
  reason?: string;
}

function getImageBackendPath(): string {
  return path.join(getPiAgentDir(), "image-generation.json");
}

export async function readImageBackendConfig(): Promise<{ provider: string; model: string } | null> {
  try {
    const content = await fs.readFile(getImageBackendPath(), "utf-8");
    const parsed = readJsonRecord(content);
    const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    return provider && model ? { provider, model } : null;
  } catch {
    return null;
  }
}

async function writeImageBackendConfig(content: { provider: string; model: string } | null): Promise<void> {
  const filePath = getImageBackendPath();
  if (!content) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

/** Base URL for a provider, taking a models.json override over the built-in one. */
async function providerBaseUrl(providerId: string): Promise<string> {
  const models = readJsonRecord(await readPiModelsJson().catch(() => "{}"));
  const providersValue = models.providers;
  const providers = providersValue && typeof providersValue === "object" && !Array.isArray(providersValue)
    ? providersValue as Record<string, unknown>
    : {};
  const override = providers[providerId];
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const url = (override as Record<string, unknown>).baseUrl;
    if (typeof url === "string" && url.trim()) return url.trim().replace(/\/+$/, "");
  }
  try {
    const runtime = await getPiModelRuntime();
    const provider = runtime.getProviders().find((item) => item.id === providerId) as { baseUrl?: string } | undefined;
    if (typeof provider?.baseUrl === "string" && provider.baseUrl.trim()) {
      return provider.baseUrl.trim().replace(/\/+$/, "");
    }
  } catch {
    // Falls through to "no base url", which is reported as not configured.
  }
  return "";
}

/** Which API dialect a provider speaks, models.json override first. */
async function providerApi(providerId: string): Promise<string | undefined> {
  const models = readJsonRecord(await readPiModelsJson().catch(() => "{}"));
  const providersValue = models.providers;
  const providers = providersValue && typeof providersValue === "object" && !Array.isArray(providersValue)
    ? providersValue as Record<string, unknown>
    : {};
  const override = providers[providerId];
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const api = (override as Record<string, unknown>).api;
    if (typeof api === "string" && api.trim()) return api.trim().toLowerCase();
  }
  try {
    const runtime = await getPiModelRuntime();
    const provider = runtime.getProviders().find((item) => item.id === providerId) as { api?: unknown } | undefined;
    if (typeof provider?.api === "string" && provider.api.trim()) return provider.api.trim().toLowerCase();
  } catch {
    // Unknown dialect means "do not probe", which is the safe answer.
  }
  return undefined;
}

/**
 * Which image backend this workspace can actually use right now.
 *
 * Images used to be enabled by the mere presence of the managed gateway token,
 * which survives switching to your own model - so a workspace that had
 * deliberately left Eggent AI still showed Eggent image generation as active
 * and still spent included credits on it. The two now travel together: the
 * managed backend serves images only while the managed text model is the one
 * answering. A workspace on its own provider brings its own image model, or has
 * none, and both the settings screen and the agent say so plainly.
 */
export async function getImageGenerationState(): Promise<ImageGenerationState> {
  const [auth, modelLock] = await Promise.all([
    readAuthJson().catch((): Record<string, StoredCredentialRecord> => ({})),
    getEggentAiModelLockState(),
  ]);

  if (modelLock.locked) {
    const token = typeof auth["eggent-ai"]?.key === "string" ? auth["eggent-ai"].key : "";
    const baseUrl = await providerBaseUrl("eggent-ai");
    if (token.startsWith("eggw_") && baseUrl) {
      return { enabled: true, provider: "eggent", label: modelLock.label, providerId: "eggent-ai" };
    }
    return { enabled: false, provider: "none", label: "Not configured", reason: "missing_managed_gateway_token" };
  }

  const configured = await readImageBackendConfig();
  if (!configured) {
    return { enabled: false, provider: "none", label: "Not configured", reason: "no_image_model_selected" };
  }
  const credential = auth[configured.provider];
  if (!credential) {
    return {
      enabled: false,
      provider: "none",
      label: "Not configured",
      providerId: configured.provider,
      model: configured.model,
      reason: "image_provider_not_connected",
    };
  }
  const baseUrl = await providerBaseUrl(configured.provider);
  if (!baseUrl) {
    return {
      enabled: false,
      provider: "none",
      label: "Not configured",
      providerId: configured.provider,
      model: configured.model,
      reason: "image_provider_has_no_base_url",
    };
  }
  return {
    enabled: true,
    provider: "custom",
    label: `${configured.provider} · ${configured.model}`,
    providerId: configured.provider,
    model: configured.model,
  };
}

/**
 * The same decision as {@link getImageGenerationState}, plus the endpoint.
 *
 * Kept here rather than re-derived by the tool so there is one place that
 * decides whether images are available and where they are sent.
 */
export async function resolveImageBackend(): Promise<
  { providerId: string; model: string; baseUrl: string; managed: boolean } | null
> {
  const state = await getImageGenerationState();
  if (!state.enabled || !state.providerId) return null;
  const baseUrl = await providerBaseUrl(state.providerId);
  if (!baseUrl) return null;
  return {
    providerId: state.providerId,
    model: state.provider === "eggent" ? "eggent-ai" : state.model || "",
    baseUrl,
    managed: state.provider === "eggent",
  };
}

/**
 * Point image generation at one of the workspace's own providers.
 *
 * Only providers this workspace already holds a credential for are accepted, so
 * saving cannot leave the same "selected but unusable" state that the text model
 * used to allow. Passing null clears the choice.
 */
export async function setImageGenerationBackend(
  input: { provider: string; model: string } | null
): Promise<ImageGenerationState> {
  if (!input) {
    await writeImageBackendConfig(null);
    return await getImageGenerationState();
  }
  const provider = input.provider.trim();
  const model = input.model.trim();
  if (!provider || !model) throw new Error("Choose an image provider and enter a model id.");
  const auth = await readAuthJson().catch((): Record<string, StoredCredentialRecord> => ({}));
  if (!auth[provider]) {
    throw new Error(`Connect ${provider} first: this workspace has no credential for it.`);
  }
  if (!(await providerBaseUrl(provider))) {
    throw new Error(`${provider} has no base URL, so it cannot serve image requests.`);
  }
  await writeImageBackendConfig({ provider, model });
  return await getImageGenerationState();
}

async function writeAuthJson(content: Record<string, StoredCredentialRecord>): Promise<void> {
  const filePath = getPiAuthPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function setPiApiKeyCredential(provider: string, apiKey: string, env?: Record<string, string>): Promise<void> {
  if ((await getEggentAiModelLockState()).locked) {
    throw new Error("Provider credentials are managed by Eggent AI for this workspace.");
  }

  const auth = await readAuthJson();
  auth[provider] = env ? { type: "api_key", key: apiKey, env } : { type: "api_key", key: apiKey };
  await writeAuthJson(auth);
}

export async function deletePiCredential(provider: string): Promise<void> {
  if ((await getEggentAiModelLockState()).locked) {
    throw new Error("Provider credentials are managed by Eggent AI for this workspace.");
  }

  const auth = await readAuthJson();
  // The managed gateway token is not the user's to delete, and deleting it is
  // unrecoverable from inside the workspace: it also backs image generation and
  // is the only way back to the included model. Switching away from Eggent AI
  // already unlocks the model choice without touching this credential.
  const key = auth[provider]?.key;
  if (typeof key === "string" && key.startsWith("eggw_")) {
    throw new Error(
      "This is the included Eggent AI credential and cannot be removed here. Pick another provider to stop using it; it stays available so you can switch back."
    );
  }
  delete auth[provider];
  await writeAuthJson(auth);
}

export async function getPiModelRuntime(): Promise<ModelRuntime> {
  const ModelRuntime = getPiSdkExport<{ create?: (options: { authPath: string; modelsPath: string }) => Promise<ModelRuntime> }>("ModelRuntime");
  if (typeof ModelRuntime.create !== "function") {
    throw new Error('Eggent runtime SDK export "ModelRuntime.create" is unavailable.');
  }
  return ModelRuntime.create({ authPath: getPiAuthPath(), modelsPath: getPiModelsPath() });
}

export async function getPiModelRegistry(modelRuntime?: ModelRuntime): Promise<ModelRegistry> {
  const runtime = modelRuntime || await getPiModelRuntime();
  const ModelRegistry = getPiSdkExport<{ new(runtime: ModelRuntime): ModelRegistry }>("ModelRegistry");
  return new ModelRegistry(runtime);
}

export async function readPiModelsJson(): Promise<string> {
  try {
    return await fs.readFile(getPiModelsPath(), "utf-8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return JSON.stringify({ providers: {} }, null, 2);
    }
    throw error;
  }
}

export async function writePiModelsJson(content: string): Promise<string> {
  if ((await getEggentAiModelLockState()).locked) {
    throw new Error("Model settings are managed by Eggent AI for this workspace.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim() ? content : JSON.stringify({ providers: {} }));
  } catch {
    throw new Error("models.json must be valid JSON.");
  }

  const normalized = JSON.stringify(parsed, null, 2);
  const filePath = getPiModelsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, normalized, "utf-8");
  return normalized;
}

/** Streaming APIs the runtime can speak, from the provider docs. */
const SUPPORTED_PROVIDER_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
]);

const PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Add or replace one custom provider in models.json, keeping the rest of the
 * file intact.
 *
 * Adding a provider is preparation, not a switch: it changes nothing about
 * which model answers, so it is allowed while the workspace is still on the
 * included model. Use switchToModelProvider to actually move onto it.
 *
 * The API key never goes into models.json. Credentials belong in auth.json,
 * which is written 0600 and is where the runtime looks them up by provider id.
 */
/**
 * Ask the workspace's current provider why it is answering with nothing.
 *
 * Returns null when there is nothing to say — no provider selected, or the
 * provider answered normally and the emptiness came from somewhere else.
 */
export async function diagnoseCurrentProvider(): Promise<
  (ProviderProbe & { provider: string; model?: string; localOnly: boolean }) | null
> {
  try {
    const settings = await getPiSettingsState();
    const provider = settings.defaultProvider?.trim();
    if (!provider) return null;
    const model = settings.defaultModel?.trim() || undefined;
    const baseUrl = await providerBaseUrl(provider);
    if (!baseUrl) return null;

    const localOnly = isLocalOnlyBaseUrl(baseUrl);
    if (localOnly) {
      return { ok: false, reason: "unreachable", provider, model, localOnly: true };
    }

    // Only ask providers that speak the dialect the probe knows. Guessing at an
    // Anthropic or Vertex endpoint the OpenAI way answers 401 for a key that is
    // fine, and naming the wrong cause is worse than admitting we do not know.
    if (!canProbeProviderApi(await providerApi(provider))) {
      return { ok: false, reason: "not_checked", provider, model, localOnly: false };
    }

    const auth = await readAuthJson().catch((): Record<string, StoredCredentialRecord> => ({}));
    const stored = auth[provider] as { key?: unknown } | undefined;
    const apiKey = typeof stored?.key === "string" ? stored.key : undefined;

    const probe = await probeModelProvider({ baseUrl, apiKey, model });
    return { ...probe, provider, model, localOnly: false };
  } catch {
    return null;
  }
}

export async function upsertCustomModelProvider(params: {
  id: string;
  baseUrl: string;
  models: string[];
  api?: string;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<{
  provider: string;
  models: string[];
  hasKey: boolean;
  api: string;
  localOnly: boolean;
  check: ProviderProbe;
}> {
  if (isManagedAiEnforced()) {
    throw new Error(
      `Model selection is managed for this workspace. To use your own provider, run Eggent self-hosted: ${selfHostedDocsUrl()}`
    );
  }

  const id = params.id.trim().toLowerCase();
  if (!PROVIDER_ID_REGEX.test(id)) {
    throw new Error(
      "Provider id may contain only lowercase letters, numbers, dots, underscores and hyphens, and must start with a letter or number."
    );
  }
  const managedProviderId = await getManagedProviderId();
  if (id === "eggent-ai" || (managedProviderId && id === managedProviderId)) {
    throw new Error(`"${id}" is the included provider and cannot be redefined here.`);
  }

  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("baseUrl must start with http:// or https://.");
  }

  const api = (params.api?.trim() || "openai-completions").toLowerCase();
  if (!SUPPORTED_PROVIDER_APIS.has(api)) {
    throw new Error(`Unsupported api "${api}". Supported: ${[...SUPPORTED_PROVIDER_APIS].join(", ")}.`);
  }

  const models = params.models.map((model) => model.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error("At least one model id is required.");
  }

  const parsed = readJsonRecord(await readPiModelsJson());
  const providers = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
    ? { ...(parsed.providers as Record<string, unknown>) }
    : {};
  providers[id] = { baseUrl, api, models: models.map((model) => ({ id: model })) };

  const filePath = getPiModelsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ ...parsed, providers }, null, 2)}\n`, "utf-8");

  const apiKey = params.apiKey?.trim();
  const auth = await readAuthJson().catch((): Record<string, StoredCredentialRecord> => ({}));
  if (apiKey) {
    auth[id] = params.env ? { type: "api_key", key: apiKey, env: params.env } : { type: "api_key", key: apiKey };
    await writeAuthJson(auth);
  }

  // hasKey answers "can this provider authenticate", not "did this call carry a
  // key". Reporting the argument meant re-registering a provider to check on it
  // came back as "registered without a key" while the key sat in auth.json, and
  // the agent went looking for a problem that was not there.
  const stored = auth[id] as { key?: unknown } | undefined;
  const hasKey = Boolean(apiKey) || Boolean(typeof stored?.key === "string" && stored.key.trim());

  const effectiveKey = apiKey || (typeof stored?.key === "string" ? stored.key : undefined);
  const localOnly = isLocalOnlyBaseUrl(baseUrl);
  const check = localOnly || !canProbeProviderApi(api)
    ? ({ ok: false, reason: "not_checked" } as ProviderProbe)
    : await probeModelProvider({ baseUrl, apiKey: effectiveKey, model: models[0] });

  return { provider: id, models, hasKey, api, localOnly, check };
}

/**
 * Move the workspace onto a provider it already has a credential for.
 *
 * Leaving the included model unlocks the choice but blanks the default, so a
 * switch that then fails validation would leave the workspace with no model at
 * all. The lock is therefore restored when the selection does not go through.
 */
export async function switchToModelProvider(
  provider: string,
  model: string,
  cwd = process.cwd()
): Promise<Awaited<ReturnType<typeof getPiSettingsState>>> {
  if (isManagedAiEnforced()) {
    throw new Error(
      `Model selection is managed for this workspace. To use your own model, run Eggent self-hosted: ${selfHostedDocsUrl()}`
    );
  }

  const wasLocked = (await getEggentAiModelLockState(cwd)).locked;
  if (wasLocked) {
    await disableEggentAiModelLock(cwd);
  }

  try {
    return await updatePiModelDefaults({ provider, model }, cwd);
  } catch (error) {
    if (wasLocked) {
      await enableEggentAiModelLock(cwd).catch(() => undefined);
    }
    throw error;
  }
}

export function getPiSettingsManager(cwd = process.cwd()): SettingsManager {
  const SettingsManager = getPiSdkExport<{ create?: (cwd: string, agentDir?: string) => SettingsManager }>("SettingsManager");
  if (typeof SettingsManager.create !== "function") {
    throw new Error('Eggent runtime SDK export "SettingsManager.create" is unavailable.');
  }
  return SettingsManager.create(cwd, getPiAgentDir());
}

/**
 * Whether this deployment forbids switching away from the managed model at all.
 *
 * Self-hosted Eggent never sets this, so the OSS behaviour is unchanged: the
 * managed lock stays advisory and the user can always opt out. A managed
 * deployment sets EGGENT_MANAGED_AI_ENFORCED=true, and then the lock cannot be
 * lifted from inside the workspace.
 */
export function isManagedAiEnforced(): boolean {
  return isTruthyEnv(process.env.EGGENT_MANAGED_AI_ENFORCED);
}

/** Where users should go to run Eggent with their own model. */
export function selfHostedDocsUrl(): string {
  return process.env.EGGENT_SELF_HOSTED_DOCS_URL?.trim() || "https://github.com/eggent-ai/eggent";
}

/**
 * Free-form text supplied by whoever operates this deployment, injected into the
 * agent's context verbatim.
 *
 * Eggent itself has no opinion about what belongs here. A hosted deployment may
 * describe its terms, where to pay, or who to contact; self-hosted Eggent
 * normally leaves it unset, in which case no such block exists at all. Keeping
 * the text outside the codebase is what lets one binary serve both.
 */
export function deploymentContext(): string | undefined {
  const raw = process.env.EGGENT_DEPLOYMENT_CONTEXT?.trim();
  if (!raw) return undefined;
  // Operators write this in an .env file, so allow the usual escaped newlines.
  return raw.replace(/\\n/g, "\n").slice(0, 4000);
}

/**
 * One short line the operator wants shown to the user on an empty chat.
 *
 * Separate from {@link deploymentContext} on purpose: that text is addressed to
 * the model and reads like instructions, which is not something to put in front
 * of a person. Unset means nothing is rendered.
 */
export function deploymentNotice(): string | undefined {
  const raw = process.env.EGGENT_DEPLOYMENT_NOTICE?.trim();
  if (!raw) return undefined;
  return raw.replace(/\\n/g, "\n").slice(0, 500);
}

export interface EggentAiModelLockState {
  locked: boolean;
  label: string;
  /** True when the lock cannot be lifted from inside this workspace. */
  enforced: boolean;
  /** Where to send users who want to run their own model. Only set when enforced. */
  selfHostedUrl?: string;
}

/** What became of an attempt to point the workspace at a provider's model. */
export interface DefaultModelSelection {
  /** False means the workspace still answers on whatever it answered on before. */
  switched: boolean;
  /** The provider asked for, or the one selected when switched is true. */
  provider?: string;
  /** The model now in effect. Only set when switched is true. */
  model?: string;
  /** Why nothing was selected. Absent when switched is true. */
  reason?: "model_locked" | "no_available_model";
}

export async function getEggentAiModelLockState(cwd = process.cwd()): Promise<EggentAiModelLockState> {
  const label = eggentAiModelLabel();

  // Checked before the override file on purpose: an enforced deployment must not
  // be unlockable by writing eggent-ai-lock.json from inside the workspace.
  if (isManagedAiEnforced()) {
    return { locked: true, label, enforced: true, selfHostedUrl: selfHostedDocsUrl() };
  }

  const override = await readEggentAiLockOverride();
  if (override.disabled === true) return { locked: false, label, enforced: false };

  if (isTruthyEnv(process.env.EGGENT_AI_MODEL_LOCKED) || isTruthyEnv(process.env.EGGENT_MANAGED_AI_LOCKED)) {
    return { locked: true, label, enforced: false };
  }

  const settingsManager = getPiSettingsManager(cwd);
  const defaultProvider = settingsManager.getDefaultProvider();
  if (!defaultProvider) return { locked: false, label, enforced: false };

  const auth: Record<string, StoredCredentialRecord> = await readAuthJson().catch(() => ({}));
  const key = auth[defaultProvider]?.key;
  if (typeof key === "string" && key.startsWith("eggw_")) {
    return { locked: true, label, enforced: false };
  }

  return { locked: false, label, enforced: false };
}

/**
 * The managed gateway token this workspace was provisioned with.
 *
 * It normally lives in auth.json, but that file is user-editable and the
 * credential can be lost - by a disconnect, by overwriting the entry with
 * something else, by hand. The deployment also passes the same token in the
 * environment, so the workspace can always recover its own included access
 * instead of asking the user for a key they were never given.
 */
function managedTokenFromEnv(): string | null {
  const candidates = [process.env.EGGENT_MANAGED_AI_TOKEN, process.env.EGGENT_USAGE_API_TOKEN];
  for (const candidate of candidates) {
    const token = candidate?.trim();
    if (token && token.startsWith("eggw_")) return token;
  }
  return null;
}

/** Whether the workspace can be put back on the included model at all. */
export async function managedCredentialRecoverable(): Promise<boolean> {
  return Boolean((await getManagedProviderId()) || managedTokenFromEnv());
}

/**
 * Put the managed token back into auth.json when it is missing.
 *
 * Overwrites whatever sits under the managed provider id: if it is not the
 * gateway token, it cannot serve the included model anyway.
 */
async function restoreManagedCredential(): Promise<string | null> {
  const existing = await getManagedProviderId();
  if (existing) return existing;
  const token = managedTokenFromEnv();
  if (!token) return null;
  const auth = await readAuthJson();
  auth["eggent-ai"] = { type: "api_key", key: token } as never;
  await writeAuthJson(auth);
  return "eggent-ai";
}

/** The included model as it is described to the runtime. */
export const MANAGED_MODEL_CONTEXT_WINDOW = 272000;
export const MANAGED_MODEL_MAX_TOKENS = 128000;

/**
 * Where the included model is served from, for rebuilding its models.json entry.
 *
 * A managed deployment can state it outright. Failing that it is derived from
 * the usage endpoint, which every managed workspace already carries and which
 * sits on the same host as the gateway - so the repair below works on
 * workspaces provisioned before the explicit variable existed, without waiting
 * for a new .env to reach all of them.
 */
function managedProviderBaseUrl(): string | null {
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

export interface ManagedProviderRepair {
  /** True when the included model had to be written back into models.json. */
  repaired: boolean;
  /** Set when the previous models.json could not be parsed and was set aside. */
  backupPath?: string;
}

/**
 * Put the included model back into models.json when its entry is gone or broken.
 *
 * The entry is written once at provisioning into a file the settings screen
 * lets people edit and replace wholesale. Losing it leaves a workspace holding
 * a valid gateway token and no model to run it on, and nothing inside the
 * workspace could put it back: the settings screen showed the included model as
 * connected while every chat answered "no model is selected".
 *
 * Only this one key is rewritten. Providers the user connected themselves are
 * carried across untouched, credentials are not touched at all, and a
 * models.json that does not parse is set aside rather than merged into nothing,
 * so nobody's own configuration is lost to the repair.
 */
async function restoreManagedProviderEntry(providerId: string): Promise<ManagedProviderRepair> {
  const baseUrl = managedProviderBaseUrl();
  if (!baseUrl) {
    throw new Error("This deployment does not say where the included model is served from.");
  }
  const api = process.env.EGGENT_AI_MODEL_API?.trim().toLowerCase() || "openai-completions";
  const label = eggentAiModelLabel();
  const entry = {
    name: label,
    baseUrl,
    api,
    models: [{
      id: providerId,
      name: label,
      input: ["text", "image"],
      contextWindow: MANAGED_MODEL_CONTEXT_WINDOW,
      maxTokens: MANAGED_MODEL_MAX_TOKENS,
    }],
  };

  const raw = await readPiModelsJson();
  let parsed: Record<string, unknown> = {};
  let backupPath: string | undefined;
  try {
    parsed = readJsonRecord(raw);
  } catch {
    // Hand-edited into invalid JSON. There is nothing to merge with, so keep the
    // file instead of overwriting it and say where it went.
    backupPath = `${getPiModelsPath()}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.writeFile(backupPath, raw, "utf-8").catch(() => undefined);
  }

  const providersValue = parsed.providers;
  const providers = providersValue && typeof providersValue === "object" && !Array.isArray(providersValue)
    ? { ...(providersValue as Record<string, unknown>) }
    : {};
  const current = providers[providerId];
  const alreadyCorrect = !backupPath && JSON.stringify(current) === JSON.stringify(entry);
  if (alreadyCorrect) return { repaired: false };

  providers[providerId] = entry;
  const filePath = getPiModelsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ ...parsed, providers }, null, 2)}\n`, "utf-8");
  return { repaired: true, backupPath };
}

/**
 * The provider backed by the managed gateway credential, identified by its
 * `eggw_` token prefix. Returns null when no managed credential is present.
 */
/**
 * What a run should use when neither the project nor the workspace named a model.
 *
 * Never the managed one. Leaving the included model is a deliberate act, but the
 * gateway credential stays behind on purpose, so "first available model" put the
 * workspace straight back on it: settings said disconnected while every chat
 * answer still came from the included model and still spent included credits.
 * With no other provider connected there is no fallback at all, and the run says
 * no model is selected instead of quietly choosing one.
 */
export async function fallbackRuntimeModel<T extends { provider: string }>(models: T[]): Promise<T | undefined> {
  const managedProvider = await getManagedProviderId();
  if (!managedProvider) return models[0];
  return models.find((model) => model.provider !== managedProvider);
}

export async function getManagedProviderId(): Promise<string | null> {
  const auth: Record<string, StoredCredentialRecord> = await readAuthJson().catch(() => ({}));
  for (const [providerId, record] of Object.entries(auth)) {
    if (typeof record?.key === "string" && record.key.startsWith("eggw_")) return providerId;
  }
  return null;
}

export async function disableEggentAiModelLock(cwd = process.cwd()): Promise<void> {
  if (isManagedAiEnforced()) {
    throw new Error(
      `Model selection is managed for this workspace. To use your own model or provider, run Eggent self-hosted: ${selfHostedDocsUrl()}`
    );
  }
  await writeEggentAiLockOverride({ disabled: true });
  // Keep the managed gateway credential in auth.json. Once the text/agent model
  // is unlocked, this token becomes the separate Eggent Images backend so users
  // can combine BYOK/OAuth text models (for example Codex login) with managed
  // image generation without losing the original gateway token.
  const settingsManager = getPiSettingsManager(cwd);
  if (settingsManager.getDefaultProvider() === "eggent-ai") {
    settingsManager.setDefaultProvider("");
    settingsManager.setDefaultModel("");
    await settingsManager.flush();
  }
}

/**
 * Put the workspace back on the included Eggent AI model.
 *
 * Switching to your own provider only sets an override file; the managed
 * credential stays. Without this there was no way back short of editing files
 * on disk, and the settings screen offered an empty API-key box for a
 * credential the workspace already had.
 */
export async function enableEggentAiModelLock(cwd = process.cwd()): Promise<ManagedProviderRepair> {
  const managedProvider = (await getManagedProviderId()) || (await restoreManagedCredential());
  if (!managedProvider) {
    throw new Error("This workspace has no Eggent AI credential to switch back to.");
  }
  // Coming back needs both halves of the included model: the credential, put
  // back above, and its description in models.json, put back here. Repairing
  // before anything is changed means a repair that cannot run leaves the
  // workspace exactly as it was.
  const repair = await restoreManagedProviderEntry(managedProvider);

  // The model id, never the display label: settings.json is matched against the
  // registry by exact id, and a label that matches nothing silently falls back
  // to whatever model happens to be first - which is some other provider.
  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  await modelRegistry.refresh();
  const managedModel = modelRegistry.getAll().find((model) => model.provider === managedProvider);
  // Never fall back to the provider id here. Writing it into defaultModel is
  // what turned a lost models.json entry into a workspace that reported the
  // included model as selected and then had nothing to answer with.
  if (!managedModel) {
    throw new Error("The included model could not be restored for this workspace.");
  }

  await removeEggentAiLockOverride();
  const settingsManager = getPiSettingsManager(cwd);
  settingsManager.setDefaultProvider(managedProvider);
  settingsManager.setDefaultModel(managedModel.id);
  await settingsManager.flush();
  return repair;
}

export async function getPiSettingsState(cwd = process.cwd()) {
  const settingsManager = getPiSettingsManager(cwd);
  const globalSettings = settingsManager.getGlobalSettings();
  return {
    settingsFile: path.join(getPiAgentDir(), "settings.json"),
    defaultProvider: settingsManager.getDefaultProvider(),
    defaultModel: settingsManager.getDefaultModel(),
    defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
    globalSettings,
  };
}

export async function updatePiModelDefaults(options: {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}, cwd = process.cwd()) {
  if ((await getEggentAiModelLockState(cwd)).locked) {
    throw new Error("Model selection is managed by Eggent AI for this workspace.");
  }

  const settingsManager = getPiSettingsManager(cwd);
  const provider = options.provider?.trim();
  const model = options.model?.trim();

  // Choosing the included model back is a switch, not a sign-in. Users get here
  // by picking Eggent AI from the provider list and pressing save, and asking
  // them for an API key at that point asks for a key they were never given.
  if (provider && (provider === "eggent-ai" || provider === (await getManagedProviderId()))) {
    if (await managedCredentialRecoverable()) {
      await enableEggentAiModelLock(cwd);
      return getPiSettingsState(cwd);
    }
  }

  // A provider can be picked from the catalog long before it has a key, and
  // saving that selection used to succeed silently: every later message then
  // failed with a generic model error while the workspace looked configured.
  // Refuse the selection instead, and say what is missing.
  if (provider) {
    const modelRuntime = await getPiModelRuntime();
    const modelRegistry = await getPiModelRegistry(modelRuntime);
    await modelRegistry.refresh();
    const available = modelRegistry.getAvailable().filter((entry) => entry.provider === provider);
    if (available.length === 0) {
      const name = modelRegistry.getProviderDisplayName(provider) || provider;
      throw new Error(
        `${name} has no credentials in this workspace yet, so it cannot be made the default. Connect it first - add its API key or sign in - and then pick the model.`
      );
    }
    if (model && !available.some((entry) => entry.id === model)) {
      const name = modelRegistry.getProviderDisplayName(provider) || provider;
      throw new Error(`${name} has no available model "${model}" in this workspace.`);
    }
  }

  if (provider && model) {
    settingsManager.setDefaultModelAndProvider(provider, model);
  } else if (provider) {
    settingsManager.setDefaultProvider(provider);
  } else if (model) {
    settingsManager.setDefaultModel(model);
  }
  if (options.thinkingLevel?.trim()) {
    settingsManager.setDefaultThinkingLevel(options.thinkingLevel.trim() as never);
  }
  await settingsManager.flush();
  return getPiSettingsState(cwd);
}

/**
 * Make a provider's first usable model the workspace default, and say whether
 * that actually happened.
 *
 * Both ways of failing used to return the current settings unchanged, and every
 * caller answered 200 with them, so a key that saved but never took effect was
 * indistinguishable from one that did. The workspace kept answering on the
 * included model, and kept billing to it, while its owner believed he had moved
 * to his own - for two hours, in the case that brought this to light.
 */
export async function setPiDefaultToFirstAvailableModel(
  provider?: string,
  cwd = process.cwd()
): Promise<DefaultModelSelection> {
  const preferredProvider = provider?.trim() || undefined;

  if ((await getEggentAiModelLockState(cwd)).locked) {
    return { switched: false, provider: preferredProvider, reason: "model_locked" };
  }

  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  await modelRegistry.refresh();

  const available = modelRegistry.getAvailable();
  const selected = preferredProvider
    ? available.find((model) => model.provider === preferredProvider)
    : available[0];

  if (!selected) {
    return { switched: false, provider: preferredProvider, reason: "no_available_model" };
  }

  const settingsManager = getPiSettingsManager(cwd);
  settingsManager.setDefaultModelAndProvider(selected.provider, selected.id);
  await settingsManager.flush();
  return { switched: true, provider: selected.provider, model: selected.id };
}

export async function getResolvedPiRuntimeModel(projectId?: string | null): Promise<PiRuntimeStats> {
  const normalizedProjectId = projectId?.trim() && projectId.trim() !== "none" ? projectId.trim() : undefined;
  const cwd = normalizedProjectId ? getWorkDir(normalizedProjectId) : getWorkDir(null);
  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  const settingsManager = getPiSettingsManager(cwd);
  await modelRegistry.refresh();

  const availableModels = modelRegistry.getAvailable();
  const findAvailableModel = (provider?: string, modelId?: string) => {
    if (!provider || !modelId) return undefined;
    return availableModels.find((model) => model.provider === provider && model.id === modelId);
  };

  const projectModelSettings = normalizedProjectId ? await loadProjectModelSettings(normalizedProjectId) : null;
  const projectConfiguredModel = projectModelSettings && projectModelSettings.inheritsGlobal !== true
    ? findAvailableModel(
        typeof projectModelSettings.provider === "string" ? projectModelSettings.provider : undefined,
        typeof projectModelSettings.model === "string" ? projectModelSettings.model : undefined
      )
    : undefined;
  const globalConfiguredModel = findAvailableModel(settingsManager.getDefaultProvider(), settingsManager.getDefaultModel());
  const modelLock = await getEggentAiModelLockState(cwd);
  // Same rule as the session: on the managed model, resolve it from the managed
  // credential so the reported context window belongs to the model that will run.
  const managedModel = modelLock.locked
    ? await (async () => {
        const managedProvider = await getManagedProviderId();
        if (!managedProvider) return undefined;
        return availableModels.find((model) => model.provider === managedProvider);
      })()
    : undefined;
  const configuredModel = managedModel
    || projectConfiguredModel
    || globalConfiguredModel
    || (modelLock.locked ? availableModels[0] : await fallbackRuntimeModel(availableModels));

  return {
    model: configuredModel
      ? modelLock.locked
        ? {
            id: modelLock.label,
            name: modelLock.label,
          }
        : {
            provider: configuredModel.provider,
            id: configuredModel.id,
            name: configuredModel.name,
          }
      : undefined,
    context: configuredModel?.contextWindow
      ? {
          tokens: null,
          contextWindow: configuredModel.contextWindow,
          percent: null,
        }
      : undefined,
  };
}

export async function getPiModelsState() {
  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  await modelRegistry.refresh();

  const [available, storedCredentials, settings] = await Promise.all([
    Promise.resolve(modelRegistry.getAvailable()),
    modelRuntime.listCredentials() as Promise<readonly StoredCredentialInfo[]>,
    getPiSettingsState(),
  ]);
  const storedAuth = Object.fromEntries(storedCredentials.map((credential) => [credential.providerId, credential]));
  const all = modelRegistry.getAll();
  const providers = modelRuntime.getProviders();
  const providerIds = Array.from(new Set(all.map((model) => model.provider))).sort();
  const oauthProviders = providers
    .filter((provider) => Boolean(provider.auth?.oauth))
    .map((provider) => ({
      id: provider.id,
      name: provider.auth?.oauth?.name || provider.name || provider.id,
      usesCallbackServer: Boolean(provider.auth?.oauth && "callback" in provider.auth.oauth),
    }));
  const subscriptionOnlyProviderIds = new Set(["openai-codex", "github-copilot"]);
  const serializeModel = (model: (typeof all)[number], isAvailable: boolean) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    available: isAvailable,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: Boolean(model.reasoning),
    input: model.input,
  });
  const isAvailable = (provider: string, modelId: string) =>
    available.some((item) => item.provider === provider && item.id === modelId);
  const currentModel = settings.defaultProvider && settings.defaultModel
    ? all.find((model) => model.provider === settings.defaultProvider && model.id === settings.defaultModel)
    : undefined;
  const modelLock = await getEggentAiModelLockState();
  const imageGeneration = await getImageGenerationState();

  if (modelLock.locked) {
    const lockedModel = currentModel
      ? {
          ...serializeModel(currentModel, true),
          provider: "eggent-ai",
          id: modelLock.label,
          name: modelLock.label,
          available: true,
        }
      : {
          provider: "eggent-ai",
          id: modelLock.label,
          name: modelLock.label,
          available: true,
          contextWindow: 128000,
          maxTokens: 16384,
          reasoning: false,
          input: ["text", "image"],
        };
    return {
      agentDir: getPiAgentDir(),
      authFile: getPiAuthPath(),
      settings: {
        ...settings,
        defaultProvider: "eggent-ai",
        defaultModel: modelLock.label,
      },
      modelsFile: getPiModelsPath(),
      modelLock,
      imageGeneration,
      current: {
        provider: "eggent-ai",
        providerName: modelLock.label,
        model: lockedModel,
        auth: { configured: true, source: "managed", label: modelLock.label },
        credentialType: "api_key",
        stored: false,
      },
      oauthProviders: [],
      apiKeyProviders: [],
      credentials: [],
      providers: [{
        id: "eggent-ai",
        name: modelLock.label,
        auth: { configured: true, source: "managed", label: modelLock.label },
        credentialType: "api_key",
        stored: false,
        modelCount: 1,
        availableModelCount: 1,
      }],
      models: [lockedModel],
      availableModels: [lockedModel],
    };
  }

  // The managed credential survives switching to your own provider, and can be
  // recovered from the environment even when auth.json lost it, so the UI can
  // always offer a way back instead of an empty API-key box.
  const managedProviderId = await getManagedProviderId();
  const managedRecoverable = await managedCredentialRecoverable();

  return {
    agentDir: getPiAgentDir(),
    authFile: getPiAuthPath(),
    settings,
    modelsFile: getPiModelsPath(),
    modelLock,
    imageGeneration,
    // Only providers this workspace already holds a credential for can serve
    // images, so the image picker offers exactly those and nothing else.
    imageProviders: Object.keys(storedAuth)
      .filter((provider) => provider !== "eggent-ai")
      .map((provider) => ({ id: provider, name: modelRegistry.getProviderDisplayName(provider) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    managed: { available: managedRecoverable, providerId: managedProviderId || "eggent-ai", label: modelLock.label },
    current: currentModel ? {
      provider: settings.defaultProvider,
      providerName: modelRegistry.getProviderDisplayName(settings.defaultProvider || currentModel.provider),
      model: serializeModel(currentModel, isAvailable(currentModel.provider, currentModel.id)),
      auth: modelRegistry.getProviderAuthStatus(currentModel.provider),
      credentialType: storedAuth[currentModel.provider]?.type,
      stored: Boolean(storedAuth[currentModel.provider]),
    } : null,
    oauthProviders,
    apiKeyProviders: providerIds
      .filter((provider) => !subscriptionOnlyProviderIds.has(provider))
      .map((provider) => ({
        id: provider,
        name: modelRegistry.getProviderDisplayName(provider),
        auth: modelRegistry.getProviderAuthStatus(provider),
      })),
    credentials: Object.entries(storedAuth).map(([provider, credential]) => ({
      provider,
      providerName: modelRegistry.getProviderDisplayName(provider),
      type: credential.type,
      auth: modelRegistry.getProviderAuthStatus(provider),
    })).sort((a, b) => a.providerName.localeCompare(b.providerName)),
    providers: providerIds.map((provider) => ({
      id: provider,
      name: modelRegistry.getProviderDisplayName(provider),
      auth: modelRegistry.getProviderAuthStatus(provider),
      credentialType: storedAuth[provider]?.type,
      stored: Boolean(storedAuth[provider]),
      modelCount: all.filter((model) => model.provider === provider).length,
      availableModelCount: available.filter((model) => model.provider === provider).length,
    })),
    models: all.map((model) => serializeModel(model, isAvailable(model.provider, model.id))),
    availableModels: available.map((model) => serializeModel(model, true)),
  };
}
