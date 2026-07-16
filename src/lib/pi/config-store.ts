import "@/lib/pi/env";
import fs from "fs/promises";
import path from "path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiRuntimeStats } from "@/lib/pi/types";
import { getWorkDir, loadProjectModelSettings } from "@/lib/storage/project-store";

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

export function getPiAuthStorage(): AuthStorage {
  const AuthStorage = getPiSdkExport<{ create?: () => AuthStorage }>("AuthStorage");
  if (typeof AuthStorage.create !== "function") {
    throw new Error('Eggent runtime SDK export "AuthStorage.create" is unavailable.');
  }
  return AuthStorage.create();
}

export function getPiModelsPath(): string {
  return path.join(getPiAgentDir(), "models.json");
}

export function getPiModelRegistry(authStorage = getPiAuthStorage()): ModelRegistry {
  const ModelRegistry = getPiSdkExport<{ create?: (authStorage: AuthStorage, modelsPath: string) => ModelRegistry }>("ModelRegistry");
  if (typeof ModelRegistry.create !== "function") {
    throw new Error('Eggent runtime SDK export "ModelRegistry.create" is unavailable.');
  }
  return ModelRegistry.create(authStorage, getPiModelsPath());
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
  const SettingsManager = getPiSdkExport<{ create?: (cwd: string) => SettingsManager }>("SettingsManager");
  if (typeof SettingsManager.create !== "function") {
    throw new Error('Eggent runtime SDK export "SettingsManager.create" is unavailable.');
  }
  return SettingsManager.create(cwd);
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
    settingsManager.setDefaultThinkingLevel(options.thinkingLevel.trim());
  }
  await settingsManager.flush();
  return getPiSettingsState(cwd);
}

export async function setPiDefaultToFirstAvailableModel(provider?: string, cwd = process.cwd()) {
  const authStorage = getPiAuthStorage();
  const modelRegistry = getPiModelRegistry(authStorage);
  await authStorage.reload();
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
  const authStorage = getPiAuthStorage();
  const modelRegistry = getPiModelRegistry(authStorage);
  const settingsManager = getPiSettingsManager(cwd);
  await authStorage.reload();
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

  return {
    model: configuredModel
      ? {
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
  const authStorage = getPiAuthStorage();
  const modelRegistry = getPiModelRegistry(authStorage);
  await authStorage.reload();
  await modelRegistry.refresh();

  const [available, storedAuth, settings] = await Promise.all([
    modelRegistry.getAvailable(),
    authStorage.getAll(),
    getPiSettingsState(),
  ]);
  const all = modelRegistry.getAll();
  const providerIds = Array.from(new Set(all.map((model) => model.provider))).sort();
  const oauthProviders = authStorage.getOAuthProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    usesCallbackServer: Boolean(provider.usesCallbackServer),
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

  return {
    agentDir: getPiAgentDir(),
    authFile: path.join(getPiAgentDir(), "auth.json"),
    settings,
    modelsFile: getPiModelsPath(),
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
