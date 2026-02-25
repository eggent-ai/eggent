import { embed, embedMany } from "ai";
import { createEmbeddingModel } from "@/lib/providers/llm-provider";

/**
 * Generate embeddings for an array of texts
 */
export async function embedTexts(
  texts: string[],
  config: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  }
): Promise<number[][]> {
  try {
    // Mock mode for testing without API keys
    if (config.provider === "mock") {
      const dim = config.dimensions || 1536;
      const count = texts.length;
      // Return random normalized vectors
      return Array(count).fill(0).map(() => {
        const vec = Array(dim).fill(0).map(() => Math.random() - 0.5);
        const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
        return vec.map(v => v / norm);
      });
    }

    const model = createEmbeddingModel(config);

    if (texts.length === 1) {
      const { embedding } = await embed({
        model,
        value: texts[0],
      });
      return [embedding];
    }

    const { embeddings } = await embedMany({
      model,
      values: texts,
    });
    return embeddings;
  } catch (error) {
    console.error("Embedding error:", error);
    throw new Error(
      `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
