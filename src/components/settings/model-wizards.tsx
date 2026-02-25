"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import type { AppSettings } from "@/lib/types";

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
  const requiresApiKey = providerConfig?.requiresApiKey ?? true;

  const hasProvider = !!provider;
  const hasApiKey = !requiresApiKey || !!apiKey;
  const hasModel = !!model;
  const currentStep = !hasProvider
    ? 1
    : !hasApiKey
      ? 2
      : !hasModel
        ? requiresApiKey
          ? 3
          : 2
        : requiresApiKey
          ? 4
          : 3;

  const { models, loading, error } = useModels(
    provider,
    apiKey,
    requiresApiKey,
    "chat",
    settings.chatModel.baseUrl
  );

  return (
    <section className="border rounded-xl p-5 bg-card space-y-5 transition-all duration-300">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Chat Model</h3>
        <div className="flex items-center gap-4">
          <StepIndicator step={1} currentStep={currentStep} label="Provider" />
          {requiresApiKey && (
            <StepIndicator step={2} currentStep={currentStep} label="API Key" />
          )}
          <StepIndicator
            step={requiresApiKey ? 3 : 2}
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
            updateSettings("chatModel.provider", nextProvider);
            updateSettings("chatModel.model", "");

            if (nextProvider === "ollama") {
              updateSettings("chatModel.baseUrl", "http://localhost:11434/v1");
              updateSettings("chatModel.apiKey", "");
            } else {
              updateSettings("chatModel.baseUrl", "");
            }
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
        } ${!requiresApiKey ? "hidden" : ""}`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — API Key
        </Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(event) => updateSettings("chatModel.apiKey", event.target.value)}
          placeholder={
            providerConfig?.envKey
              ? `Enter key or set ${providerConfig.envKey} in .env`
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

      {hasProvider && !requiresApiKey && provider === "ollama" && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg px-3 py-2">
          <Check className="size-4" />
          API Key not required — connecting to local Ollama
        </div>
      )}

      {(provider === "custom" || provider === "ollama") && (
        <div
          className={`space-y-2 transition-all duration-300 ${
            !hasApiKey ? "opacity-40 pointer-events-none" : ""
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
                : "https://api.example.com/v1"
            }
            disabled={!hasApiKey}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasApiKey ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {requiresApiKey ? "Step 3" : "Step 2"} — Model
        </Label>
        <ModelSelect
          value={model}
          models={models}
          loading={loading}
          error={error}
          disabled={!hasApiKey}
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
    custom: { name: "Custom (OpenAI-compatible)", requiresApiKey: true },
  };

  const providerConfig = embeddingProviders[provider] || embeddingProviders.openai;
  const requiresApiKey = providerConfig.requiresApiKey;

  const hasProvider = !!provider && provider !== "mock";
  const hasApiKey = !requiresApiKey || !!apiKey;
  const hasModel = !!model;
  const currentStep = !hasProvider
    ? 1
    : !hasApiKey
      ? 2
      : !hasModel
        ? requiresApiKey
          ? 3
          : 2
        : requiresApiKey
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
          {requiresApiKey && (
            <StepIndicator step={2} currentStep={currentStep} label="API Key" />
          )}
          <StepIndicator
            step={requiresApiKey ? 3 : 2}
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
        } ${!requiresApiKey ? "hidden" : ""}`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 2 — API Key
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

      {provider === "ollama" && (
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
            placeholder="http://localhost:11434/v1"
            disabled={!hasProvider}
          />
        </div>
      )}

      <div
        className={`space-y-2 transition-all duration-300 ${
          !hasApiKey ? "opacity-40 pointer-events-none" : ""
        }`}
      >
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {requiresApiKey ? "Step 3" : "Step 2"} — Model
        </Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <ModelSelect
              value={model}
              models={models}
              loading={loading}
              error={error}
              disabled={!hasApiKey}
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
              disabled={!hasApiKey}
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
