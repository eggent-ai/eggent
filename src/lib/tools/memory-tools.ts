import { insertMemory, searchMemory, deleteMemoryByQuery } from "@/lib/memory/memory";
import type { AppSettings } from "@/lib/types";

/**
 * Save text to memory
 */
export async function memorySave(
  text: string,
  area: string,
  memorySubdir: string,
  settings: AppSettings
): Promise<string> {
  try {
    const id = await insertMemory(text, area, memorySubdir, settings);
    return `Memory saved successfully (ID: ${id}, area: ${area})`;
  } catch (error) {
    return `Failed to save memory: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Search memory for relevant information
 */
export async function memoryLoad(
  query: string,
  limit: number,
  memorySubdir: string,
  settings: AppSettings
): Promise<string> {
  try {
    const results = await searchMemory(
      query,
      limit,
      settings.memory.similarityThreshold,
      memorySubdir,
      settings
    );

    if (results.length === 0) {
      return "No relevant memories found.";
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}] (score: ${r.score.toFixed(3)}, area: ${r.metadata.area || "unknown"})\n${r.text}`
      )
      .join("\n\n");

    return `Found ${results.length} relevant memories:\n\n${formatted}`;
  } catch (error) {
    return `Failed to search memory: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Delete memories matching a query
 */
export async function memoryDelete(
  query: string,
  memorySubdir: string,
  settings: AppSettings
): Promise<string> {
  try {
    const count = await deleteMemoryByQuery(query, memorySubdir, settings);
    if (count === 0) {
      return "No matching memories found to delete.";
    }
    return `Deleted ${count} matching memory entries.`;
  } catch (error) {
    return `Failed to delete memories: ${error instanceof Error ? error.message : String(error)}`;
  }
}
