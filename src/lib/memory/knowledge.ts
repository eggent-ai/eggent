import fs from "fs/promises";
import path from "path";
import { insertMemory, searchMemory, deleteMemoryByMetadata } from "@/lib/memory/memory";
import type { AppSettings } from "@/lib/types";
import { loadDocument } from "@/lib/memory/loaders";
import { RecursiveCharacterTextSplitter } from "@/lib/memory/text-splitter";

/**
 * Supported file extensions
 */
const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".html",
  ".py", ".js", ".ts", ".xml", ".yaml", ".yml", ".log",
  ".pdf",
  ".docx", ".xlsx", ".xls",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"
]);

function createSplitterOptions(settings: AppSettings) {
  const rawChunkSize = Number(settings.memory.chunkSize);
  const chunkSize =
    Number.isFinite(rawChunkSize) && rawChunkSize > 0
      ? Math.round(rawChunkSize)
      : 400;

  return {
    chunkSize,
    // Keep overlap proportional to chunk size to preserve local context.
    chunkOverlap: Math.max(20, Math.floor(chunkSize * 0.2)),
    separators: ["\n\n", "\n", " ", ""] as const,
  };
}

/**
 * Import a single knowledge file: remove its existing chunks, then load and insert new ones.
 * Use this on upload so we don't duplicate chunks when other files are added/removed.
 */
export async function importKnowledgeFile(
  knowledgeDir: string,
  memorySubdir: string,
  settings: AppSettings,
  filename: string
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const result = { imported: 0, skipped: 0, errors: [] as string[] };
  const ext = path.extname(filename).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    result.skipped++;
    return result;
  }

  try {
    await deleteMemoryByMetadata("filename", filename, memorySubdir);
  } catch {
    // ignore
  }

  const splitter = new RecursiveCharacterTextSplitter(createSplitterOptions(settings));
  const filePath = path.join(knowledgeDir, filename);

  try {
    const doc = await loadDocument(filePath);
    if (!doc || !doc.text.trim()) {
      result.skipped++;
      return result;
    }

    const chunks = await splitter.splitText(doc.text);
    for (const chunk of chunks) {
      await insertMemory(
        chunk,
        "knowledge",
        memorySubdir,
        settings,
        { filename }
      );
      result.imported++;
    }
  } catch (error) {
    result.errors.push(
      `Error processing ${filename}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}

/**
 * Import all knowledge files from a directory into the vector DB.
 * For each file, existing chunks are removed first, then new chunks are inserted (no duplicates).
 */
export async function importKnowledge(
  knowledgeDir: string,
  memorySubdir: string,
  settings: AppSettings
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const result = { imported: 0, skipped: 0, errors: [] as string[] };
  const splitter = new RecursiveCharacterTextSplitter(createSplitterOptions(settings));

  try {
    try {
      await fs.access(knowledgeDir);
    } catch {
      return result;
    }

    const entries = await fs.readdir(knowledgeDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        result.skipped++;
        continue;
      }

      try {
        await deleteMemoryByMetadata("filename", entry.name, memorySubdir);
      } catch {
        // ignore
      }

      const filePath = path.join(knowledgeDir, entry.name);
      try {
        const doc = await loadDocument(filePath);
        if (!doc || !doc.text.trim()) {
          result.skipped++;
          continue;
        }

        const chunks = await splitter.splitText(doc.text);
        for (const chunk of chunks) {
          await insertMemory(
            chunk,
            "knowledge",
            memorySubdir,
            settings,
            { filename: entry.name }
          );
          result.imported++;
        }
      } catch (error) {
        result.errors.push(
          `Error processing ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    result.errors.push(
      `Error reading directory: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}

/**
 * Query the knowledge base
 */
export async function queryKnowledge(
  query: string,
  limit: number,
  knowledgeSubdirs: string[],
  settings: AppSettings
): Promise<string> {
  const allResults: Array<{
    text: string;
    score: number;
    metadata: Record<string, unknown>;
  }> = [];

  for (const subdir of knowledgeSubdirs) {
    try {
      const results = await searchMemory(
        query,
        limit,
        settings.memory.similarityThreshold,
        subdir,
        settings,
        "knowledge"
      );
      allResults.push(...results);
    } catch {
      // Skip subdirs that don't exist
    }
  }

  if (allResults.length === 0) {
    return "No relevant documents found in the knowledge base.";
  }

  // Sort by score and deduplicate
  allResults.sort((a, b) => b.score - a.score);

  // Simple deduplication based on text content
  const seen = new Set<string>();
  const unique = allResults.filter(r => {
    if (seen.has(r.text)) return false;
    seen.add(r.text);
    return true;
  }).slice(0, limit);

  const formatted = unique
    .map(
      (r, i) =>
        `[Document ${i + 1}] (relevance: ${(r.score * 100).toFixed(1)}%)\n${r.text}`
    )
    .join("\n\n---\n\n");

  return `Found ${unique.length} relevant document chunks:\n\n${formatted}`;
}
