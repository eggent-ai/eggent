import "@/lib/pi/env";
import fs from "fs/promises";
import path from "path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function getPiAuthStorage() {
  return AuthStorage.create();
}

export function getPiModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

export function getPiModelRegistry(authStorage = getPiAuthStorage()) {
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

export function getPiSettingsManager(cwd = process.cwd()) {
  return SettingsManager.create(cwd);
}

export async function getPiSettingsState(cwd = process.cwd()) {
  const settingsManager = getPiSettingsManager(cwd);
  const globalSettings = settingsManager.getGlobalSettings();
  return {
    settingsFile: path.join(getAgentDir(), "settings.json"),
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

export async function getPiModelsState() {
  const authStorage = getPiAuthStorage();
  const modelRegistry = getPiModelRegistry(authStorage);
  await authStorage.reload();
  await modelRegistry.refresh();

  const [available, storedAuth] = await Promise.all([
    modelRegistry.getAvailable(),
    authStorage.getAll(),
  ]);
  const all = modelRegistry.getAll();
  const providerIds = Array.from(new Set(all.map((model) => model.provider))).sort();

  return {
    agentDir: getAgentDir(),
    authFile: path.join(getAgentDir(), "auth.json"),
    settings: await getPiSettingsState(),
    modelsFile: getPiModelsPath(),
    providers: providerIds.map((provider) => ({
      id: provider,
      name: modelRegistry.getProviderDisplayName(provider),
      auth: modelRegistry.getProviderAuthStatus(provider),
      stored: Boolean(storedAuth[provider]),
      modelCount: all.filter((model) => model.provider === provider).length,
      availableModelCount: available.filter((model) => model.provider === provider).length,
    })),
    models: all.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      available: available.some((item) => item.provider === model.provider && item.id === model.id),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: Boolean(model.reasoning),
      input: model.input,
    })),
    availableModels: available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      available: true,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: Boolean(model.reasoning),
      input: model.input,
    })),
  };
}
