import fs from "fs/promises";
import path from "path";
import { embedTexts } from "@/lib/memory/embeddings";
import type { VectorDocument, AppSettings } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");

interface MemoryDB {
  documents: VectorDocument[];
  metadata: {
    lastUpdated: string;
    count: number;
  };
}

// In-memory cache of loaded databases
const dbCache: Map<string, MemoryDB> = new Map();

function getDbPath(subdir: string): string {
  return path.join(DATA_DIR, "memory", subdir, "vectors.json");
}

/** Remove subdir from in-memory cache (e.g. when project is deleted). */
export function clearMemoryCache(subdir: string): void {
  dbCache.delete(subdir);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Load or create a vector database
 */
async function loadDB(subdir: string): Promise<MemoryDB> {
  if (dbCache.has(subdir)) {
    return dbCache.get(subdir)!;
  }

  const dbPath = getDbPath(subdir);
  try {
    const content = await fs.readFile(dbPath, "utf-8");
    const db: MemoryDB = JSON.parse(content);
    dbCache.set(subdir, db);
    return db;
  } catch {
    const db: MemoryDB = {
      documents: [],
      metadata: { lastUpdated: new Date().toISOString(), count: 0 },
    };
    dbCache.set(subdir, db);
    return db;
  }
}

/**
 * Save the database to disk
 */
async function saveDB(subdir: string, db: MemoryDB): Promise<void> {
  const dbPath = getDbPath(subdir);
  await ensureDir(path.dirname(dbPath));
  db.metadata.lastUpdated = new Date().toISOString();
  db.metadata.count = db.documents.length;
  await fs.writeFile(dbPath, JSON.stringify(db), "utf-8");
  dbCache.set(subdir, db);
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Insert text into the vector database
 */
export async function insertMemory(
  text: string,
  area: string,
  subdir: string,
  settings: AppSettings,
  additionalMetadata: Record<string, unknown> = {}
): Promise<string> {
  const db = await loadDB(subdir);

  const embeddings = await embedTexts([text], settings.embeddingsModel);
  if (!embeddings || embeddings.length === 0) {
    throw new Error("Failed to generate embedding");
  }

  const id = crypto.randomUUID();
  const doc: VectorDocument = {
    id,
    text,
    embedding: embeddings[0],
    metadata: {
      area,
      createdAt: new Date().toISOString(),
      ...additionalMetadata,
    },
  };

  db.documents.push(doc);
  await saveDB(subdir, db);
  return id;
}

/**
 * Search for similar documents
 */
export async function searchMemory(
  query: string,
  limit: number,
  threshold: number,
  subdir: string,
  settings: AppSettings,
  areaFilter?: string
): Promise<{ id: string; text: string; score: number; metadata: Record<string, unknown> }[]> {
  const db = await loadDB(subdir);
  if (db.documents.length === 0) return [];

  const embeddings = await embedTexts([query], settings.embeddingsModel);
  if (!embeddings || embeddings.length === 0) return [];

  const queryEmbedding = embeddings[0];

  // Calculate similarities
  let results = db.documents
    .map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
      metadata: doc.metadata,
    }))
    .filter((r) => r.score >= threshold);

  // Apply area filter
  if (areaFilter) {
    results = results.filter((r) => r.metadata.area === areaFilter);
  }

  // Sort by score descending and limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Delete documents by query (finds similar and removes)
 */
export async function deleteMemoryByQuery(
  query: string,
  subdir: string,
  settings: AppSettings
): Promise<number> {
  const matches = await searchMemory(query, 5, 0.8, subdir, settings);
  if (matches.length === 0) return 0;

  const db = await loadDB(subdir);
  const idsToDelete = new Set(matches.map((m) => m.id));
  db.documents = db.documents.filter((d) => !idsToDelete.has(d.id));
  await saveDB(subdir, db);
  return idsToDelete.size;
}

/**
 * Delete a specific document by ID
 */
export async function deleteMemoryById(
  id: string,
  subdir: string
): Promise<boolean> {
  const db = await loadDB(subdir);
  const before = db.documents.length;
  db.documents = db.documents.filter((d) => d.id !== id);
  if (db.documents.length < before) {
    await saveDB(subdir, db);
    return true;
  }
  return false;
}

/**
 * Delete documents by metadata key/value match
 */
export async function deleteMemoryByMetadata(
  key: string,
  value: unknown,
  subdir: string
): Promise<number> {
  const db = await loadDB(subdir);
  const before = db.documents.length;
  db.documents = db.documents.filter((d) => d.metadata[key] !== value);
  const deleted = before - db.documents.length;

  if (deleted > 0) {
    await saveDB(subdir, db);
  }
  return deleted;
}

/**
 * Get all memory entries (for dashboard)
 */
export async function getAllMemories(
  subdir: string
): Promise<{ id: string; text: string; metadata: Record<string, unknown> }[]> {
  const db = await loadDB(subdir);
  return db.documents.map((d) => ({
    id: d.id,
    text: d.text,
    metadata: d.metadata,
  }));
}

const KNOWLEDGE_AREA = "knowledge";
const FILENAME_META = "filename";

/**
 * Get chunk counts per filename for knowledge area
 */
export async function getChunkCountsByFilename(
  subdir: string
): Promise<Record<string, number>> {
  const db = await loadDB(subdir);
  const counts: Record<string, number> = {};
  for (const doc of db.documents) {
    if (doc.metadata?.area !== KNOWLEDGE_AREA) continue;
    const name = doc.metadata[FILENAME_META];
    if (typeof name === "string") {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Get all chunks for a given knowledge file (by filename)
 */
export async function getChunksByFilename(
  subdir: string,
  filename: string
): Promise<{ id: string; text: string; index: number }[]> {
  const db = await loadDB(subdir);
  const chunks = db.documents.filter(
    (d) =>
      d.metadata?.area === KNOWLEDGE_AREA &&
      d.metadata[FILENAME_META] === filename
  );
  return chunks.map((d, i) => ({
    id: d.id,
    text: d.text,
    index: i + 1,
  }));
}
