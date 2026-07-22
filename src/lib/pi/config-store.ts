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

export async function getEggentAiModelLockState(cwd = process.cwd()): Promise<{ locked: boolean; label: string }> {
  const label = eggentAiModelLabel();
  const override = await readEggentAiLockOverride();
  if (override.disabled === true) return { locked: false, label };

  if (isTruthyEnv(process.env.EGGENT_AI_MODEL_LOCKED) || isTruthyEnv(process.env.EGGENT_MANAGED_AI_LOCKED)) {
    return { locked: true, label };
  }

  const settingsManager = getPiSettingsManager(cwd);
  const defaultProvider = settingsManager.getDefaultProvider();
  if (!defaultProvider) return { locked: false, label };

  const auth: Record<string, StoredCredentialRecord> = await readAuthJson().catch(() => ({}));
  const key = auth[defaultProvider]?.key;
  if (typeof key === "string" && key.startsWith("eggw_")) {
    return { locked: true, label };
  }

  return { locked: false, label };
}

export async function disableEggentAiModelLock(cwd = process.cwd()): Promise<void> {
  await writeEggentAiLockOverride({ disabled: true });
  const auth = await readAuthJson();
  for (const [provider, credential] of Object.entries(auth)) {
    if (provider === "eggent-ai" || (typeof credential.key === "string" && credential.key.startsWith("eggw_"))) {
      delete auth[provider];
    }
  }
  await writeAuthJson(auth);

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
          input: ["text"],
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
