import { kbEmbedder, kbEmbedderFailed } from "@/lib/kb/embed";
import { kbIndexStats, refreshKbIndex, type KbIndex, type KbIndexStats } from "@/lib/kb/index";

/**
 * Finding the passages of a project that answer a question.
 *
 * Two rankings, merged by reciprocal rank: BM25 over the words, which finds a
 * name, a number or a term exactly as written, and cosine over the vectors,
 * which finds a passage that says the same thing in other words. Without
 * vectors the words alone answer. Both run in memory over the whole index; a
 * project of 20 000 passages is a few tens of milliseconds.
 */

export interface KbPassage {
  file: string;
  place: string;
  text: string;
}

export interface KbSearchResult {
  passages: KbPassage[];
  /** "meaning" when vectors took part, "words" when only BM25 did. */
  mode: "meaning" | "words";
  stats: KbIndexStats;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const CANDIDATES = 40;
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// Words are cut to this many letters, so "vacation" and "vacations" - or a
// word and its case endings in an inflected language - count as one.
const STEM_CHARS = 6;

export function kbTokens(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    out.push(word.length > STEM_CHARS ? word.slice(0, STEM_CHARS) : word);
  }
  return out;
}

interface Bm25 {
  postings: Map<string, Array<[number, number]>>;
  lengths: Uint32Array;
  average: number;
}

const bm25Cache = new WeakMap<KbIndex, Bm25>();
const normCache = new WeakMap<KbIndex, Float32Array>();

function bm25Of(index: KbIndex): Bm25 {
  const cached = bm25Cache.get(index);
  if (cached) return cached;
  const postings = new Map<string, Array<[number, number]>>();
  const lengths = new Uint32Array(index.chunks.length);
  let total = 0;
  index.chunks.forEach((chunk, at) => {
    const counts = new Map<string, number>();
    const tokens = kbTokens(`${chunk.file} ${chunk.text}`);
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
      let list = postings.get(token);
      if (!list) postings.set(token, (list = []));
      list.push([at, count]);
    }
    lengths[at] = tokens.length;
    total += tokens.length;
  });
  const built = { postings, lengths, average: index.chunks.length ? total / index.chunks.length : 0 };
  bm25Cache.set(index, built);
  return built;
}

function rankWords(index: KbIndex, query: string): number[] {
  const bm25 = bm25Of(index);
  const scores = new Map<number, number>();
  const count = index.chunks.length;
  for (const token of new Set(kbTokens(query))) {
    const list = bm25.postings.get(token);
    if (!list) continue;
    const idf = Math.log(1 + (count - list.length + 0.5) / (list.length + 0.5));
    for (const [at, tf] of list) {
      const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * bm25.lengths[at] / (bm25.average || 1)));
      scores.set(at, (scores.get(at) ?? 0) + idf * norm);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([at]) => at);
}

function normsOf(index: KbIndex): Float32Array {
  const cached = normCache.get(index);
  if (cached) return cached;
  const dims = index.embedder?.dims ?? 0;
  const vectors = index.vectors as Float32Array;
  const norms = new Float32Array(index.chunks.length);
  for (let row = 0; row < norms.length; row += 1) {
    let sum = 0;
    for (let i = row * dims; i < (row + 1) * dims; i += 1) sum += vectors[i] * vectors[i];
    norms[row] = Math.sqrt(sum);
  }
  normCache.set(index, norms);
  return norms;
}

function rankMeaning(index: KbIndex, query: Float32Array): number[] {
  const dims = index.embedder?.dims ?? 0;
  const vectors = index.vectors;
  if (!vectors || query.length !== dims) return [];
  const norms = normsOf(index);
  let queryNorm = 0;
  for (let i = 0; i < dims; i += 1) queryNorm += query[i] * query[i];
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];
  const scored: Array<[number, number]> = [];
  for (let row = 0; row < norms.length; row += 1) {
    // A passage not embedded yet is all zeros.
    if (norms[row] === 0) continue;
    let dot = 0;
    const offset = row * dims;
    for (let i = 0; i < dims; i += 1) dot += vectors[offset + i] * query[i];
    scored.push([row, dot / (norms[row] * queryNorm)]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([row]) => row);
}

async function embedQuery(index: KbIndex, query: string): Promise<Float32Array | null> {
  if (!index.embedder || !index.vectors) return null;
  if (!Object.values(index.files).some((entry) => entry.embedded && entry.chunks > 0)) return null;
  const embedder = await kbEmbedder();
  if (!embedder || embedder.id !== index.embedder.id) return null;
  try {
    const [vector] = await embedder.embed([query]);
    return vector ?? null;
  } catch (error) {
    console.warn("Knowledge base: the question could not be embedded, searching by words:", error instanceof Error ? error.message : error);
    kbEmbedderFailed(embedder.id);
    return null;
  }
}

/** The passages of the project at `dir` that best answer `query`, after bringing its index up to date. */
export async function searchKb(dir: string, query: string, options: { limit?: number } = {}): Promise<KbSearchResult> {
  const index = await refreshKbIndex(dir);
  const stats = kbIndexStats(index);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit || DEFAULT_LIMIT)));
  if (!query.trim() || index.chunks.length === 0) return { passages: [], mode: "words", stats };
  const words = rankWords(index, query);
  const vector = await embedQuery(index, query);
  const meaning = vector ? rankMeaning(index, vector) : [];
  const fused = new Map<number, number>();
  for (const ranking of [words, meaning]) {
    ranking.forEach((row, rank) => fused.set(row, (fused.get(row) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  const passages = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([row]) => ({ ...index.chunks[row] }));
  return { passages, mode: meaning.length > 0 ? "meaning" : "words", stats };
}
