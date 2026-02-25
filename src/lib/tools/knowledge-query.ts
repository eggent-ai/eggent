import { queryKnowledge } from "@/lib/memory/knowledge";
import type { AppSettings } from "@/lib/types";

/**
 * Query the knowledge base for relevant documents
 */
export async function knowledgeQuery(
  query: string,
  limit: number,
  knowledgeSubdirs: string[],
  settings: AppSettings
): Promise<string> {
  try {
    return await queryKnowledge(query, limit, knowledgeSubdirs, settings);
  } catch (error) {
    return `Knowledge query error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
