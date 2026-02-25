/**
 * Available model providers and their models
 */

export interface ProviderConfig {
  name: string;
  models: { id: string; name: string }[];
  embeddingModels?: { id: string; name: string; dimensions: number }[];
  envKey?: string;
  baseUrl?: string;
  requiresApiKey: boolean;
}

export const MODEL_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    name: "OpenAI",
    models: [],
    embeddingModels: [
      { id: "text-embedding-3-small", name: "Embedding 3 Small", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Embedding 3 Large", dimensions: 3072 },
    ],
    envKey: "OPENAI_API_KEY",
    requiresApiKey: true,
  },
  anthropic: {
    name: "Anthropic",
    models: [],
    envKey: "ANTHROPIC_API_KEY",
    requiresApiKey: true,
  },
  google: {
    name: "Google",
    models: [],
    envKey: "GOOGLE_API_KEY",
    requiresApiKey: true,
  },
  openrouter: {
    name: "OpenRouter",
    models: [],
    envKey: "OPENROUTER_API_KEY",
    requiresApiKey: true,
  },
  ollama: {
    name: "Ollama",
    models: [],
    embeddingModels: [
      { id: "nomic-embed-text", name: "Nomic Embed Text", dimensions: 768 },
      { id: "mxbai-embed-large", name: "MxBai Embed Large", dimensions: 1024 },
    ],
    baseUrl: "http://localhost:11434",
    requiresApiKey: false,
  },
};
