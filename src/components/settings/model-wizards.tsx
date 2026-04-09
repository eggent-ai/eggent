"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import type { AppSettings, ChatAuthMethod } from "@/lib/types";

export type UpdateSettingsFn = (path: string, value: unknown) => void;

function StepIndicator({
  step,
  currentStep,
  label,
}: {
  step: number;
  currentStep: number;
  label: string;
}) {
  const completed = currentStep > step;
  const active = currentStep === step;

  return (
    <div className="flex items-center gap-2">
      <div
        className={`
          flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold
          transition-all duration-300 shrink-0
          ${
            completed
              ? "bg-emerald-500 text-white shadow-md shadow-emerald-500/30"
              : active
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/30 ring-2 ring-primary/20"
                : "bg-muted text-muted-foreground"
          }
        `}
      >
        {completed ? <Check className="size-3.5" /> : step}
      </div>
      <span
        className={`text-sm transition-colors duration-200 ${
          active
            ? "text-foreground font-medium"
            : completed
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function ModelSelect({
  value,
  models,
  loading,
  error,
  disabled,
  onChange,
  placeholder,
}: {
  value: string;
  models: { id: string; name: string }[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || loading}
          className={`
            w-full rounded-md border bg-background px-3 py-2 text-sm appearance-none pr-8
            transition-all duration-200
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}
            ${error ? "border-red-400 dark:border-red-500" : ""}
          `}
        >
          <option value="">
            {loading ? "Loading models..." : placeholder || "Select model"}
          </option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground">
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-500">
          <AlertCircle className="size-3" />
          {error}
        </div>
      )}
    </div>
  );
}

function useModels(
  provider: string,
  apiKey: string,
  requiresApiKey: boolean,
  type: "chat" | "embedding" = "chat",
  baseUrl?: string
) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (!provider) return;
    if (requiresApiKey && !apiKey) return;
    const providerConfig = MODEL_PROVIDERS[provider];

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ provider, type });
      if (apiKey) params.set("apiKey", apiKey);
      if (baseUrl) {
        params.set("baseUrl", baseUrl);
      } else if (providerConfig?.baseUrl) {
        params.set("baseUrl", providerConfig.baseUrl);
      }

      const response = await fetch(`/api/models?${params}`);
      const payload = (await response.json()) as {
        models?: Array<{ id: string; name: string }>;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to fetch models");
      }

      if (payload.models?.length) {
        setModels(payload.models);
      } else {
        const dynamicProviders = [
          "openai",
          "openrouter",
          "ollama",
          "anthropic",
          "google",
          "custom",
        ];
        if (!dynamicProviders.includes(provider) && providerConfig?.models?.length) {
          setModels([...providerConfig.models]);
        } else {
          setModels([]);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load models");

      const providerConfig = MODEL_PROVIDERS[provider];
      const dynamicProviders = [
        "openai",
        "openrouter",
        "ollama",
        "anthropic",
        "google",
        "custom",
      ];
      if (!dynamicProviders.includes(provider) && providerConfig?.models?.length) {
        setModels([...providerConfig.models]);
      } else {
        setModels([]);
      }
    } finally {
      setLoading(false);
    }
  }, [provider, apiKey, requiresApiKey, type, baseUrl]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  return { models, loading, error };
}

export function ChatModelWizard({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
}) {
  const provider = settings.chatModel.provider;
  const apiKey = settings.chatModel.apiKey || "";
  const model = settings.chatModel.model;
  const providerConfig = MODEL_PROVIDERS[provider];
  const isCustomProvider = provider === "custom";
  const availableAuthMethods = providerConfig?.authMethods || ["api_key"];
  const selectedAuthMethod = (
    availableAuthMethods.includes((settings.chatModel.authMethod || "") as ChatAuthMethod)
      ? settings.chatModel.authMethod
      : providerConfig?.defaultAuthMethod || availableAuthMethods[0]
  ) as ChatAuthMethod;
  const requiresApiKey =
    selectedAuthMethod === "api_key" &&
    (isCustomProvider ? false : (providerConfig?.requiresApiKey ?? true));
  const isCliProvider = provider === "codex-cli" || provider === "gemini-cli";
  const hasProvider = !!provider;
  const hasModel = !!model;

  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<{
    connected: boolean;
    message: string;
    detail?: string;
  } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const { models, loading, error } = useModels(
    provider,
    apiKey,
    requiresApiKey,
    "chat",
    settings.chatModel.baseUrl
  );

  const checkConnection = useCallback(async () => {
    if (!isCliProvider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }

    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const params = new URLSearchParams({
        provider,
        method: selectedAuthMethod,
      });
      if (apiKey.trim()) {
        params.set("hasApiKey", "1");
      }
      const response = await fetch(`/api/provider-auth/status?${params.toString()}`, {
        method: "GET",
      });
      const payload = (await response.json()) as {
        connected?: boolean;
        message?: string;
        detail?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to check connection");
      }
      setConnectionStatus({
        connected: Boolean(payload.connected),
        message: payload.message || "Status updated",
        detail: payload.detail,
      });
    } catch (cause) {
      setConnectionStatus(null);
      setConnectionError(
        cause instanceof Error ? cause.message : "Failed to check connection"
      );
    } finally {
      setConnectionLoading(false);
    }
  }, [apiKey, isCliProvider, provider, selectedAuthMethod]);

  useEffect(() => {
    if (!provider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }
    if (!isCliProvider) {
      setConnectionStatus(null);
      setConnectionError(null);
      return;
    }
    void checkConnection();
  }, [checkConnection, isCliProvider, provider, selectedAuthMethod]);

  useEffect(() => {
    if (!provider) return;
    if (settings.chatModel.authMethod === selectedAuthMethod) return;
    updateSettings("chatModel.authMethod", selectedAuthMethod);
  }, [
    provider,
    selectedAuthMethod,
    settings.chatModel.authMethod,
    updateSettings,
  ]);

  const apiKeyConnectionReady = !requiresApiKey || !!apiKey.trim();
  const hasConnection = isCliProvider
    ? Boolean(connectionStatus?.connected)
    : selectedAuthMethod === "oauth"
      ? Boolean(connectionStatus?.connected)
      : apiKeyConnectionReady;
  const currentStep = !hasProvider
    ? 1
    : !selectedAuthMethod
      ? 2
      : !hasConnection
        ? 3
        : !hasModel
          ? 4
          : 5;
  const showApiKeyInput =
    selectedAuthMethod === "api_key" && (requiresApiKey || isCustomProvider);
  const connectionHelp =
    selectedAuthMethod === "oauth"
      ? providerConfig?.connectionHelp?.oauth
      : providerConfig?.connectionHelp?.apiKey;

  return (
    <section className="border rounded-xl p-5 bg-card space-y-5 transition-all duration-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Chat Model</h3>
        <div className="flex items-center gap-4">
          <StepIndicator step={1} currentStep={currentStep} label="Provider" />
          <StepIndicator step={2} currentStep={currentStep} label="Method" />
          <StepIndicator step={3} currentStep={currentStep} label="Connect" />
          <StepIndicator step={4} currentStep={currentStep} label="Model" />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 1 — Provider
        </Label>
        <select
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value;
            updateSettings("chatModel.provider", nextProvider);
            updateSettings("chatModel.model", "");
            const nextProviderConfig = MODEL_PROVIDERS[nextProvider];
            const nextAuthMethod =
              nextProviderConfig?.defaultAuthMethod ||
              nextProviderConfig?.authMethods?.[0] ||
              "api_key";
            updateSettings("chatModel.authMethod", nextAuthMethod);

            if (nextProvider === "ollama") {
              updateSettings("chatModel.baseUrl", "http://localhost:11434/v1");
              updateSettings("chatModel.apiKey", "");
            } else if (nextProvider === "custom") {
              updateSettings("chatModel.baseUrl", "http://localhost:1234/v1");
            } else if (nextProvider === "codex-cli" || nextProvider === "gemini-cli") {
              updateSettings("chatModel.baseUrl", "");
            } else {
              updateSettings("chatModel.baseUrl", "");
            }

            setConnectionStatus(null);
            setConnectionError(null);
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">Select provider...</option>
          {Object.entries(MODEL_PROVIDERS).map(([key, providerOption]) => (
            <option key={key} value={key}>
              {providerOption.name}
            </option>
          ))}
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasProvider ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — Connection Method
        </Label>
        <select
          value={selectedAuthMethod}
          onChange={(event) => {
            const method = event.target.value as ChatAuthMethod;
            updateSettings("chatModel.authMethod", method);
            updateSettings("chatModel.model", "");
            if (method === "oauth") {
              updateSettings("chatModel.apiKey", "");
            }
            setConnectionStatus(null);
            setConnectionError(null);
          }}
          disabled={!hasProvider}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {availableAuthMethods.map((authMethod) => (
            <option key={authMethod} value={authMethod}>
              {authMethod === "oauth" ? "OAuth" : "API key"}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`space-y-3 transition-all duration-300 ${
          !hasProvider || !selectedAuthMethod ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 3 — Connection
        </Label>

        {showApiKeyInput ? (
          <div className="space-y-2">
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => updateSettings("chatModel.apiKey", event.target.value)}
              placeholder={
                providerConfig?.envKey
                  ? `Enter key or set ${providerConfig.envKey} in .env`
                  : isCustomProvider
                    ? "Optional token (leave empty for local servers)"
                    : "sk-..."
              }
              disabled={!hasProvider}
            />
            {providerConfig?.envKey && (
              <p className="text-xs text-muted-foreground">
                Or set{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                  {providerConfig.envKey}
                </code>{" "}
                as an environment variable
              </p>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground rounded-lg border bg-muted/30 p-3">
            API key input is not required for this connection mode.
          </div>
        )}

        {connectionHelp && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <p className="text-sm font-medium">{connectionHelp.title}</p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
              {connectionHelp.steps.map((step, idx) => (
                <li key={`${provider}-${selectedAuthMethod}-help-${idx}`}>{step}</li>
              ))}
            </ul>
            {connectionHelp.command && (
              <p className="text-sm">
                Command:{" "}
                <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                  {connectionHelp.command}
                </code>
              </p>
            )}
          </div>
        )}

        {isCliProvider && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            OAuth tokens are read from local CLI auth files.
          </div>
        )}

        {isCliProvider && (
          <button
            type="button"
            onClick={() => void checkConnection()}
            disabled={connectionLoading}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-60"
          >
            {connectionLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Check connection
          </button>
        )}

        {provider === "ollama" && selectedAuthMethod === "api_key" && (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
            <Check className="size-4" />
            API Key not required — connecting to local Ollama
          </div>
        )}
        {provider === "custom" && selectedAuthMethod === "api_key" && !apiKey.trim() && (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
            <Check className="size-4" />
            API Key optional — works for local OpenAI-compatible servers (LM Studio, etc.)
          </div>
        )}

        {isCliProvider && connectionStatus && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              connectionStatus.connected
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
            }`}
          >
            <p>{connectionStatus.message}</p>
            {connectionStatus.detail && (
              <p className="mt-1 text-xs opacity-80">{connectionStatus.detail}</p>
            )}
          </div>
        )}

        {connectionError && (
          <div className="flex items-center gap-1.5 text-xs text-red-500">
            <AlertCircle className="size-3" />
            {connectionError}
          </div>
        )}
      </div>

      {(provider === "custom" || provider === "ollama") && selectedAuthMethod === "api_key" && (
        <div
          className={`space-y-2 transition-all duration-300 ${
            !apiKeyConnectionReady ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Base URL
          </Label>
          <Input
            value={settings.chatModel.baseUrl || ""}
            onChange={(event) => updateSettings("chatModel.baseUrl", event.target.value)}
            placeholder={
              provider === "ollama"
                ? "http://localhost:11434/v1"
                : "http://localhost:1234/v1"
            }
            disabled={!apiKeyConnectionReady}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasConnection ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 4 — Model
        </Label>
        <ModelSelect
          value={model}
          models={models}
          loading={loading}
          error={error}
          disabled={!hasConnection}
          onChange={(value) => updateSettings("chatModel.model", value)}
          placeholder="Select model..."
        />
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !model ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Temperature
        </Label>
        <Input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={settings.chatModel.temperature || 0.7}
          onChange={(event) =>
            updateSettings("chatModel.temperature", parseFloat(event.target.value))
          }
          disabled={!model}
          className="max-w-[120px]"
        />
      </div>
    </section>
  );
}

export function EmbeddingsModelWizard({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: UpdateSettingsFn;
}) {
  const provider = settings.embeddingsModel.provider;
  const apiKey = settings.embeddingsModel.apiKey || "";
  const model = settings.embeddingsModel.model;

  const embeddingProviders: Record<
    string,
    { name: string; requiresApiKey: boolean; envKey?: string; baseUrl?: string }
  > = {
    openai: { name: "OpenAI", requiresApiKey: true, envKey: "OPENAI_API_KEY" },
    openrouter: {
      name: "OpenRouter",
      requiresApiKey: true,
      envKey: "OPENROUTER_API_KEY",
    },
    ollama: {
      name: "Ollama",
      requiresApiKey: false,
      baseUrl: "http://localhost:11434",
    },
    google: { name: "Google", requiresApiKey: true, envKey: "GOOGLE_API_KEY" },
    custom: { name: "Custom (OpenAI-compatible)", requiresApiKey: false },
  };

  const providerConfig = embeddingProviders[provider] || embeddingProviders.openai;
  const requiresApiKey = providerConfig.requiresApiKey;
  const showApiKeyInput = requiresApiKey || provider === "custom";

  const hasProvider = !!provider && provider !== "mock";
  const hasApiKey = !requiresApiKey || !!apiKey;
  const hasModel = !!model;
  const currentStep = !hasProvider
    ? 1
    : requiresApiKey && !hasApiKey
      ? 2
      : !hasModel
        ? requiresApiKey
          ? 3
          : showApiKeyInput
            ? 3
            : 2
        : requiresApiKey
          ? 4
          : showApiKeyInput
            ? 4
            : 3;

  const { models, loading, error } = useModels(
    provider,
    apiKey,
    requiresApiKey,
    "embedding",
    settings.embeddingsModel.baseUrl
  );

  const knownDimensions: Record<string, number> = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    "text-embedding-004": 768,
    "nomic-embed-text": 768,
    "mxbai-embed-large": 1024,
    "all-minilm": 384,
    "bge-m3": 1024,
    "bge-large": 1024,
    "bge-base": 768,
    "e5-large": 1024,
    "e5-base": 768,
    "multilingual-e5": 1024,
    "mistral-embed": 1024,
    "gte-large": 1024,
    "gte-base": 768,
    "mpnet-base": 768,
  };

  return (
    <section className="border rounded-xl p-5 bg-card space-y-5 transition-all duration-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Embeddings Model</h3>
        <div className="flex items-center gap-4">
          <StepIndicator step={1} currentStep={currentStep} label="Provider" />
          {showApiKeyInput && (
            <StepIndicator step={2} currentStep={currentStep} label="API Key" />
          )}
          <StepIndicator
            step={showApiKeyInput ? 3 : 2}
            currentStep={currentStep}
            label="Model"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 1 — Provider
        </Label>
        <select
          value={provider}
          onChange={(event) => {
            const nextProvider = event.target.value;
            updateSettings("embeddingsModel.provider", nextProvider);
            updateSettings("embeddingsModel.model", "");
            if (nextProvider === "ollama") {
              updateSettings("embeddingsModel.baseUrl", "http://localhost:11434/v1");
              updateSettings("embeddingsModel.apiKey", "");
            } else if (nextProvider === "custom") {
              updateSettings("embeddingsModel.baseUrl", "http://localhost:1234/v1");
            } else {
              updateSettings("embeddingsModel.baseUrl", "");
            }
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">Select provider...</option>
          {Object.entries(embeddingProviders).map(([key, providerOption]) => (
            <option key={key} value={key}>
              {providerOption.name}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasProvider ? "opacity-40 pointer-events-none" : ""
        } ${!showApiKeyInput ? "hidden" : ""}`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — API Key {provider === "custom" && !requiresApiKey ? "(optional)" : ""}
        </Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(event) =>
            updateSettings("embeddingsModel.apiKey", event.target.value)
          }
          placeholder={
            providerConfig.envKey
              ? `Enter key or set ${providerConfig.envKey} in .env`
              : provider === "custom"
                ? "Optional token (leave empty for local servers)"
                : "sk-..."
          }
          disabled={!hasProvider}
        />
        {providerConfig.envKey && (
          <p className="text-xs text-muted-foreground">
            Or set{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
              {providerConfig.envKey}
            </code>{" "}
            as an environment variable
          </p>
        )}
      </div>

      {hasProvider && !requiresApiKey && provider === "ollama" && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
          <Check className="size-4" />
          API Key not required — connecting to local Ollama
        </div>
      )}

      {(provider === "ollama" || provider === "custom") && (
        <div
          className={`space-y-2 transition-all duration-300 ${
            !hasProvider ? "opacity-40 pointer-events-none" : ""
          }`}
        >
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Base URL
          </Label>
          <Input
            value={settings.embeddingsModel.baseUrl || ""}
            onChange={(event) =>
              updateSettings("embeddingsModel.baseUrl", event.target.value)
            }
            placeholder={
              provider === "ollama"
                ? "http://localhost:11434/v1"
                : "http://localhost:1234/v1"
            }
            disabled={!hasProvider}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          requiresApiKey && !hasApiKey ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {showApiKeyInput ? "Step 3" : "Step 2"} — Model
        </Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <ModelSelect
              value={model}
              models={models}
              loading={loading}
              error={error}
              disabled={requiresApiKey && !hasApiKey}
              onChange={(value) => {
                updateSettings("embeddingsModel.model", value);
                let dimensions = 1536;
                for (const [pattern, knownValue] of Object.entries(knownDimensions)) {
                  if (value.includes(pattern)) {
                    dimensions = knownValue;
                    break;
                  }
                }
                updateSettings("embeddingsModel.dimensions", dimensions);
              }}
              placeholder="Select embedding model..."
            />
          </div>
          <div className="w-24">
            <Input
              type="number"
              value={settings.embeddingsModel.dimensions || 1536}
              onChange={(event) =>
                updateSettings(
                  "embeddingsModel.dimensions",
                  parseInt(event.target.value, 10)
                )
              }
              placeholder="Dims"
              title="Embedding Dimensions"
              disabled={requiresApiKey && !hasApiKey}
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Dimensions are auto-detected for known models. Adjust if necessary.
        </p>
      </div>
    </section>
  );
}
