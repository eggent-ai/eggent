import { NextRequest } from "next/server";
import { MODEL_PROVIDERS } from "@/lib/providers/model-config";
import { getSettings } from "@/lib/storage/settings-store";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || "";
    let apiKey = searchParams.get("apiKey") || "";
    const type = searchParams.get("type") || "chat"; // "chat" | "embedding"

    // If apiKey is masked or missing, try to get it from server-side settings
    if (!apiKey || apiKey.includes("****")) {
        try {
            const settings = await getSettings();
            if (type === "chat" && settings.chatModel.provider === provider) {
                apiKey = settings.chatModel.apiKey || "";
            } else if (type === "embedding" && settings.embeddingsModel.provider === provider) {
                apiKey = settings.embeddingsModel.apiKey || "";
            } else if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
                // Special case for environment variables if not in settings explicitly
                apiKey = process.env.OPENROUTER_API_KEY;
            } else if (provider === "openai" && process.env.OPENAI_API_KEY) {
                apiKey = process.env.OPENAI_API_KEY;
            } else if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
                apiKey = process.env.ANTHROPIC_API_KEY;
            } else if (provider === "google" && process.env.GOOGLE_API_KEY) {
                apiKey = process.env.GOOGLE_API_KEY;
            }
        } catch (e) {
            console.error("Failed to load settings for API key lookup", e);
        }
    }

    try {
        let models: { id: string; name: string }[] = [];

        switch (provider) {
            case "openai": {
                const res = await fetch("https://api.openai.com/v1/models", {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
                const data = await res.json();
                models = data.data
                    .filter((m: { id: string }) => {
                        if (type === "embedding") {
                            return m.id.includes("text-embedding") || m.id.includes("embedding");
                        }
                        return m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3") || m.id.startsWith("o4");
                    })
                    .map((m: { id: string }) => ({ id: m.id, name: m.id }))
                    .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
                break;
            }

            case "openrouter": {
                let url = "https://openrouter.ai/api/v1/models";
                if (type === "embedding") {
                    url = "https://openrouter.ai/api/v1/embeddings/models";
                }

                const res = await fetch(url, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                });
                if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);
                const data = await res.json();

                // OpenRouter embeddings endpoint might return array directly or { data: [] }
                const rawModels = Array.isArray(data) ? data : (data.data || []);

                models = rawModels
                    .map((m: { id: string; name?: string }) => ({
                        id: m.id,
                        name: m.name || m.id,
                    }))
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            case "ollama": {
                const rawBaseUrl = (searchParams.get("baseUrl") || "http://localhost:11434").trim();
                const normalizedBaseUrl = rawBaseUrl
                    .replace(/\/+$/, "")
                    .replace(/\/v1$/, "");

                const res = await fetch(`${normalizedBaseUrl}/api/tags`);
                if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
                const data = await res.json();
                // Ollama returns all models. We can't reliably distinguish embedding vs chat without 'show' API
                // For now, return all.
                models = (data.models || []).map((m: { name: string; model?: string }) => ({
                    id: m.name,
                    name: m.name,
                }));
                break;
            }

            case "anthropic": {
                if (type === "embedding") {
                    models = []; // Anthropic API doesn't list embedding models (they don't have public ones via this API usually)
                    break;
                }
                const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
                    headers: {
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                });
                if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
                const data = await res.json();
                models = (data.data || [])
                    .filter((m: { type: string; id: string }) => m.type === "model")
                    .map((m: { id: string; display_name?: string }) => ({
                        id: m.id,
                        name: m.display_name || m.id,
                    }))
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            case "google": {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
                );
                if (!res.ok) throw new Error(`Google API error: ${res.status}`);
                const data = await res.json();
                models = (data.models || [])
                    .map((m: { name: string; displayName?: string }) => ({
                        id: m.name.replace("models/", ""),
                        name: m.displayName || m.name.replace("models/", ""),
                    }))
                    .filter((m: { id: string }) => {
                        if (type === "embedding") {
                            return m.id.includes("embedding");
                        }
                        return m.id.includes("gemini");
                    })
                    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                break;
            }

            default: {
                const providerConfig = MODEL_PROVIDERS[provider];
                if (providerConfig) {
                    models = [...providerConfig.models];
                }
                break;
            }
        }

        return Response.json({ models });
    } catch (error) {
        return Response.json(
            {
                error: error instanceof Error ? error.message : "Failed to fetch models",
                models: [],
            },
            { status: 500 }
        );
    }
}
