import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { ModelConfig } from "@/lib/types";

type OpenAICompatibleSettings = {
  providerName: string;
  apiKey: string;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeBaseUrl(rawBaseUrl: string | undefined, settings: {
  providerName: string;
  fallbackBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultPath?: string;
}): string | undefined {
  const rawValue = (rawBaseUrl || settings.fallbackBaseUrl || "").trim();

  if (!rawValue) {
    if (settings.baseUrlRequired) {
      throw new Error(
        `${settings.providerName}: baseUrl is required. Example: https://api.example.com/v1`
      );
    }
    return undefined;
  }

  const hasScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(rawValue);
  const withScheme = hasScheme
    ? rawValue
    : `${LOCAL_HOSTNAMES.has(rawValue.split("/")[0] || "") ? "http" : "https"}://${rawValue}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(
      `${settings.providerName}: invalid baseUrl "${rawValue}". Use absolute URL, e.g. https://api.example.com/v1`
    );
  }

  if (settings.defaultPath && (parsed.pathname === "" || parsed.pathname === "/")) {
    parsed.pathname = settings.defaultPath;
  }

  return parsed.toString().replace(/\/$/, "");
}

function createOpenAICompatibleChatModel(
  config: ModelConfig,
  settings: OpenAICompatibleSettings
): LanguageModel {
  const baseURL = normalizeBaseUrl(config.baseUrl, settings);
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    baseURL,
    name: settings.providerName,
  });
  return provider.chat(config.model);
}

function createOpenAICompatibleEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}, settings: OpenAICompatibleSettings) {
  const baseURL = normalizeBaseUrl(config.baseUrl, settings);
  const provider = createOpenAI({
    apiKey: settings.apiKey,
    baseURL,
    name: settings.providerName,
  });
  return provider.embedding(config.model);
}

/**
 * Create an AI SDK language model from our ModelConfig
 */
export function createModel(config: ModelConfig): LanguageModel {
  switch (config.provider) {
    case "openai": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "openai",
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      });
    }

    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
        baseURL: config.baseUrl,
      });
      return anthropic(config.model);
    }

    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY || "",
        baseURL: config.baseUrl,
      });
      return google(config.model);
    }

    case "openrouter": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "openrouter",
        apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || "",
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });
    }

    case "ollama": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });
    }

    case "custom": {
      return createOpenAICompatibleChatModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        baseUrlRequired: true,
        defaultPath: "/v1",
      });
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create an embeddings model.
 */
export function createEmbeddingModel(config: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  switch (config.provider) {
    case "openai":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openai",
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      });

    case "openrouter":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "openrouter",
        apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || "",
        fallbackBaseUrl: "https://openrouter.ai/api/v1",
      });

    case "ollama":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "ollama",
        apiKey: "ollama",
        fallbackBaseUrl: "http://localhost:11434",
        defaultPath: "/v1",
      });

    case "custom":
      return createOpenAICompatibleEmbeddingModel(config, {
        providerName: "custom",
        apiKey: config.apiKey || "",
        baseUrlRequired: true,
        defaultPath: "/v1",
      });

    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey || process.env.GOOGLE_API_KEY || "",
        baseURL: config.baseUrl,
      });
      return google.embedding(config.model);
    }

    default:
      throw new Error(`Unsupported embeddings provider: ${config.provider}`);
  }
}
