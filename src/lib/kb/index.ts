import fs from "node:fs/promises";
import path from "node:path";
import { RecursiveCharacterTextSplitter } from "@/lib/memory/text-splitter";
import { publicPathAllowed, publicShareRoot, readPublicFile, type PublicShareRoot } from "@/lib/pi/public-share";
import { extractKbText, kbReadable } from "@/lib/kb/extract";
import { kbEmbedder, kbEmbedderFailed } from "@/lib/kb/embed";

/**
 * The search index of one project, kept in the project's own `.kb/` folder.
 *
 * A dot folder, so it is invisible to a public share's read, ls and search, to
 * the file history and to anything that judges paths by publicPathAllowed. It
 * holds `chunks.json` (every indexed file with its size and time, every passage
 * with its file and place) and `vectors.f32` (one row of floats per passage, in
 * the same order, zeros for a passage not embedded yet).
 *
 * It is brought up to date before every search, by the files' sizes and times:
 * only a file that changed is read and embedded again, a file that is gone
 * takes its passages with it. Only files a public share may see are read, so
 * the index cannot hold what the share's own tools would refuse to open.
 */

export const KB_DIR = ".kb";
const CHUNKS_FILE = "chunks.json";
const VECTORS_FILE = "vectors.f32";
const FORMAT = 1;

const MAX_FILES = 3000;
const MAX_TEXT_CHARS = 30 * 1024 * 1024;
const MAX_CHUNKS = 20_000;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_DEPTH = 12;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

export interface KbChunk {
  /** Path inside the project, with forward slashes. */
  file: string;
  /** Where in the file, as a person would look for it: "page 3", "line 40". */
  place: string;
  text: string;
}

interface KbFileEntry {
  mtimeMs: number;
  size: number;
  chunks: number;
  chars: number;
  embedded: boolean;
  /** Read and found nothing, or left out because the index was full. */
  skipped?: "empty" | "full" | "too-large";
}

interface KbIndexFile {
  format: number;
  embedder: { id: string; dims: number } | null;
  files: Record<string, KbFileEntry>;
  chunks: KbChunk[];
}

export interface KbIndex {
  dir: string;
  embedder: { id: string; dims: number } | null;
  files: Record<string, KbFileEntry>;
  chunks: KbChunk[];
  /** Rows of `embedder.dims`, one per chunk; null without an embedder. */
  vectors: Float32Array | null;
}

export interface KbIndexStats {
  /** Files with at least one passage in the index. */
  files: number;
  chunks: number;
  /** Passages that have a vector. */
  embedded: number;
  /** Files left out because the index reached its limits. */
  skipped: number;
}

interface KbHolder {
  __eggentKbIndexes?: Map<string, KbIndex>;
  __eggentKbBuilds?: Map<string, Promise<KbIndex>>;
}

function holder(): Required<KbHolder> {
  const state = globalThis as unknown as KbHolder;
  state.__eggentKbIndexes ??= new Map();
  state.__eggentKbBuilds ??= new Map();
  return state as Required<KbHolder>;
}

function emptyIndex(dir: string): KbIndex {
  return { dir, embedder: null, files: {}, chunks: [], vectors: null };
}

async function loadIndex(dir: string): Promise<KbIndex> {
  const cached = holder().__eggentKbIndexes.get(dir);
  if (cached) return cached;
  const folder = path.join(dir, KB_DIR);
  try {
    const stored = JSON.parse(await fs.readFile(path.join(folder, CHUNKS_FILE), "utf8")) as KbIndexFile;
    if (stored.format !== FORMAT || !Array.isArray(stored.chunks) || !stored.files) return emptyIndex(dir);
    let vectors: Float32Array | null = null;
    if (stored.embedder) {
      const raw = await fs.readFile(path.join(folder, VECTORS_FILE)).catch(() => null);
      if (raw && raw.length === stored.chunks.length * stored.embedder.dims * 4) {
        vectors = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
      }
    }
    if (stored.embedder && !vectors) {
      // The rows are lost: the passages stay, and are embedded again.
      for (const entry of Object.values(stored.files)) entry.embedded = false;
      vectors = new Float32Array(stored.chunks.length * stored.embedder.dims);
    }
    return { dir, embedder: stored.embedder, files: stored.files, chunks: stored.chunks, vectors };
  } catch {
    return emptyIndex(dir);
  }
}

async function writeAtomically(target: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, target);
}

async function saveIndex(index: KbIndex): Promise<void> {
  const folder = path.join(index.dir, KB_DIR);
  await fs.mkdir(folder, { recursive: true });
  const stored: KbIndexFile = { format: FORMAT, embedder: index.embedder, files: index.files, chunks: index.chunks };
  if (index.vectors) {
    await writeAtomically(path.join(folder, VECTORS_FILE), new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
  } else {
    await fs.rm(path.join(folder, VECTORS_FILE), { force: true });
  }
  await writeAtomically(path.join(folder, CHUNKS_FILE), JSON.stringify(stored));
}

interface FoundFile {
  relative: string;
  absolute: string;
  mtimeMs: number;
  size: number;
}

/** Every file a public share may see and the search can read, in name order, never past the limit. */
async function listFiles(root: PublicShareRoot): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root.real, absolute);
      if (!relative || relative.startsWith("..") || !publicPathAllowed(relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || !kbReadable(entry.name)) continue;
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;
      found.push({ relative: relative.split(path.sep).join("/"), absolute, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  await walk(root.real, 0);
  return found;
}

/** Passages of at most about CHUNK_CHARS, a piece too long for one separator split by the next. */
async function splitPassages(text: string, separators = ["\n\n", "\n", " ", ""]): Promise<string[]> {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_CHARS, chunkOverlap: CHUNK_OVERLAP, separators });
  const out: string[] = [];
  for (const piece of await splitter.splitText(text)) {
    if (piece.length > CHUNK_CHARS * 1.5 && separators.length > 1) out.push(...(await splitPassages(piece, separators.slice(1))));
    else if (piece.trim()) out.push(piece);
  }
  return out;
}

async function chunkFile(file: FoundFile, root: PublicShareRoot): Promise<{ chunks: KbChunk[]; chars: number }> {
  const content = await readPublicFile(root, file.absolute, MAX_FILE_BYTES);
  const sections = await extractKbText(file.relative, file.absolute, content);
  const chunks: KbChunk[] = [];
  let chars = 0;
  for (const section of sections) {
    chars += section.text.length;
    let cursor = 0;
    let line = 1;
    let counted = 0;
    for (const passage of await splitPassages(section.text)) {
      let place = section.place;
      if (section.lines) {
        const at = section.text.indexOf(passage.slice(0, 200), cursor);
        if (at >= 0) {
          for (let i = counted; i < at; i += 1) if (section.text.charCodeAt(i) === 10) line += 1;
          counted = at;
          cursor = at + 1;
        }
        place = `${section.lines} ${line}`;
      }
      chunks.push({ file: file.relative, place, text: passage.trim() });
    }
  }
  return { chunks, chars };
}

function statsOf(index: KbIndex): KbIndexStats {
  const entries = Object.values(index.files);
  return {
    files: entries.filter((entry) => entry.chunks > 0).length,
    chunks: index.chunks.length,
    embedded: entries.reduce((sum, entry) => sum + (entry.embedded ? entry.chunks : 0), 0),
    skipped: entries.filter((entry) => entry.skipped === "full" || entry.skipped === "too-large").length,
  };
}

async function build(dir: string): Promise<KbIndex> {
  const root = await publicShareRoot(dir);
  const previous = await loadIndex(root.dir);
  const files = await listFiles(root);
  const embedder = await kbEmbedder();

  // Where each file's passages sit in the previous index.
  const spans = new Map<string, { start: number; count: number }>();
  previous.chunks.forEach((chunk, at) => {
    const span = spans.get(chunk.file);
    if (span) span.count += 1;
    else spans.set(chunk.file, { start: at, count: 1 });
  });

  let changed = Object.keys(previous.files).length !== files.length;
  const nextFiles: Record<string, KbFileEntry> = {};
  const nextChunks: KbChunk[] = [];
  const keptRows: Array<number | null> = [];
  let chars = 0;
  for (const file of files) {
    const before = previous.files[file.relative];
    const full = chars >= MAX_TEXT_CHARS || nextChunks.length >= MAX_CHUNKS;
    const span = spans.get(file.relative) ?? { start: 0, count: 0 };
    const keep = before
      && before.mtimeMs === file.mtimeMs
      && before.size === file.size
      // Left out for want of room, and there is room now.
      && !(before.skipped === "full" && !full)
      && span.count === before.chunks
      && nextChunks.length + before.chunks <= MAX_CHUNKS;
    if (keep) {
      nextFiles[file.relative] = before;
      for (let i = 0; i < before.chunks; i += 1) {
        nextChunks.push(previous.chunks[span.start + i]);
        keptRows.push(before.embedded ? span.start + i : null);
      }
      chars += before.chars;
      continue;
    }
    changed = true;
    const base = { mtimeMs: file.mtimeMs, size: file.size, chars: 0, chunks: 0, embedded: false };
    if (full) {
      nextFiles[file.relative] = { ...base, skipped: "full" };
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      nextFiles[file.relative] = { ...base, skipped: "too-large" };
      continue;
    }
    let read: { chunks: KbChunk[]; chars: number };
    try {
      read = await chunkFile(file, root);
    } catch {
      read = { chunks: [], chars: 0 };
    }
    if (read.chunks.length === 0) {
      nextFiles[file.relative] = { ...base, skipped: "empty" };
      continue;
    }
    if (chars + read.chars > MAX_TEXT_CHARS || nextChunks.length + read.chunks.length > MAX_CHUNKS) {
      nextFiles[file.relative] = { ...base, skipped: "full" };
      continue;
    }
    nextFiles[file.relative] = { ...base, chars: read.chars, chunks: read.chunks.length };
    nextChunks.push(...read.chunks);
    for (let i = 0; i < read.chunks.length; i += 1) keptRows.push(null);
    chars += read.chars;
  }
  for (const name of Object.keys(previous.files)) if (!(name in nextFiles)) changed = true;

  // Another model's vectors cannot be compared with this one's: they are made again.
  const sameEmbedder = Boolean(embedder && previous.embedder?.id === embedder.id);
  let vectorInfo = embedder ? (sameEmbedder ? previous.embedder : null) : previous.embedder;
  let vectors: Float32Array | null = null;
  if (vectorInfo && previous.vectors) {
    const dims = vectorInfo.dims;
    vectors = new Float32Array(nextChunks.length * dims);
    const from = previous.vectors;
    const target = vectors;
    keptRows.forEach((row, at) => {
      if (row !== null) target.set(from.subarray(row * dims, (row + 1) * dims), at * dims);
    });
  }
  if (embedder && !sameEmbedder) {
    for (const entry of Object.values(nextFiles)) entry.embedded = false;
    changed = true;
  }

  if (embedder) {
    const waiting = Object.entries(nextFiles).filter(([, entry]) => entry.chunks > 0 && !entry.embedded).map(([name]) => name);
    if (waiting.length > 0) {
      const wanted = new Set(waiting);
      const rows: number[] = [];
      nextChunks.forEach((chunk, at) => {
        if (wanted.has(chunk.file)) rows.push(at);
      });
      try {
        const made = await embedder.embed(rows.map((at) => `${nextChunks[at].file}\n${nextChunks[at].text}`));
        const dims = made[0].length;
        changed = true;
        if (vectorInfo && vectors && vectorInfo.dims !== dims) {
          // The model behind the same name changed its width: every passage is embedded anew next time.
          for (const entry of Object.values(nextFiles)) entry.embedded = false;
          vectorInfo = null;
          vectors = null;
        } else {
          if (!vectorInfo || !vectors) {
            vectorInfo = { id: embedder.id, dims };
            vectors = new Float32Array(nextChunks.length * dims);
          }
          const target = vectors;
          rows.forEach((at, i) => target.set(made[i], at * dims));
          for (const name of waiting) nextFiles[name].embedded = true;
        }
      } catch (error) {
        console.warn("Knowledge base: embeddings unavailable, searching by words:", error instanceof Error ? error.message : error);
        kbEmbedderFailed(embedder.id);
      }
    }
  }

  const next: KbIndex = { dir: root.dir, embedder: vectorInfo, files: nextFiles, chunks: nextChunks, vectors: vectorInfo ? vectors : null };
  if (next.embedder && !next.vectors) next.vectors = new Float32Array(nextChunks.length * next.embedder.dims);
  if (changed) await saveIndex(next);
  holder().__eggentKbIndexes.set(root.dir, next);
  return next;
}

/**
 * The project's index, brought up to date with its files.
 *
 * One build per project at a time: a search that arrives while one runs waits
 * for it and is answered by it.
 */
export function refreshKbIndex(dir: string): Promise<KbIndex> {
  const key = path.resolve(dir);
  const builds = holder().__eggentKbBuilds;
  const running = builds.get(key);
  if (running) return running;
  const started = build(key).finally(() => {
    builds.delete(key);
  });
  builds.set(key, started);
  return started;
}

export async function warmKbIndex(dir: string): Promise<KbIndexStats> {
  return statsOf(await refreshKbIndex(dir));
}

export { statsOf as kbIndexStats };
