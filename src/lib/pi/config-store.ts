import "@/lib/pi/env";
import fs from "fs/promises";
import path from "path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeStats } from "@/lib/pi/types";
import { getWorkDir, loadProjectModelSettings } from "@/lib/storage/project-store";

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

async function getEggentImagesState(): Promise<{ enabled: boolean; provider: "eggent" | "none"; label: string; reason?: string }> {
  const [auth, modelsContent] = await Promise.all([
    readAuthJson().catch((): Record<string, StoredCredentialRecord> => ({})),
    readPiModelsJson().catch(() => JSON.stringify({ providers: {} })),
  ]);
  const credential = auth["eggent-ai"];
  const token = typeof credential?.key === "string" ? credential.key : "";
  const models = readJsonRecord(modelsContent);
  const providersValue = models.providers;
  const providers = providersValue && typeof providersValue === "object" && !Array.isArray(providersValue)
    ? providersValue as Record<string, unknown>
    : {};
  const providerValue = providers["eggent-ai"];
  const provider = providerValue && typeof providerValue === "object" && !Array.isArray(providerValue)
    ? providerValue as Record<string, unknown>
    : {};
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  const label = typeof provider.name === "string" && provider.name.trim() ? provider.name.trim() : eggentAiModelLabel();
  if (token.startsWith("eggw_") && baseUrl) {
    return { enabled: true, provider: "eggent", label };
  }
  return { enabled: false, provider: "none", label: "Not configured", reason: "missing_managed_gateway_token" };
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
 * The provider backed by the managed gateway credential, identified by its
 * `eggw_` token prefix. Returns null when no managed credential is present.
 */
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

export async function setPiDefaultToFirstAvailableModel(provider?: string, cwd = process.cwd()) {
  if ((await getEggentAiModelLockState(cwd)).locked) {
    return getPiSettingsState(cwd);
  }

  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  await modelRegistry.refresh();

  const available = modelRegistry.getAvailable();
  const preferredProvider = provider?.trim();
  const selected = preferredProvider
    ? available.find((model) => model.provider === preferredProvider)
    : available[0];

  if (!selected) {
    return getPiSettingsState(cwd);
  }

  const settingsManager = getPiSettingsManager(cwd);
  settingsManager.setDefaultModelAndProvider(selected.provider, selected.id);
  await settingsManager.flush();
  return getPiSettingsState(cwd);
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
  const configuredModel = projectConfiguredModel || globalConfiguredModel || availableModels[0];
  const modelLock = await getEggentAiModelLockState(cwd);

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
  const imageGeneration = await getEggentImagesState();

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

  return {
    agentDir: getPiAgentDir(),
    authFile: getPiAuthPath(),
    settings,
    modelsFile: getPiModelsPath(),
    modelLock,
    imageGeneration,
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
