import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { versionRetention } from "@/lib/files/versions/config";
import { lineStats } from "@/lib/files/versions/diff-model";
import type { VersionAuthor, VersionInfo, VersionRetention } from "@/lib/files/versions/shape";

/**
 * Where the versions of files are kept: `data/versions`, beside the projects
 * rather than in them, so the sync never carries them to a computer and the
 * Files panel never shows them, while the disk the workspace pays for counts
 * them like anything else in `data`.
 *
 * - `objects/ab/abcdef….gz` - a file's bytes as they were, gzipped, named by
 *   their SHA-256. Two files or two versions that hold the same bytes share one.
 * - `files/12/1234….json` - one journal per file, named by the hash of its key
 *   (its path under the projects folder): every version's number, time, author,
 *   size and object.
 *
 * Everything that decides *whether* a version is made, and what bytes it holds,
 * lives in capture.ts. This module only keeps what it is given - which is the
 * part a deployment may one day keep somewhere else, out of the agent's reach
 * (`VersionStore`).
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DAY_MS = 24 * 60 * 60 * 1000;
// An object nothing names yet may be one a write is about to name.
const OBJECT_GRACE_MS = 60 * 60 * 1000;
// Stats are worked out for text up to this size; larger, the list just goes without them.
const MAX_STATS_BYTES = 1024 * 1024;

export interface JournalEntry extends VersionInfo {
  /** The object holding this version; null for a deletion. */
  sha: string | null;
}

export interface Journal {
  v: 1;
  key: string;
  /** The number the next version gets. */
  next: number;
  /** What the file was on disk when its newest version was last confirmed, to notice a change made elsewhere. */
  seen?: { mtimeMs: number; size: number };
  versions: JournalEntry[];
}

export type Seen = { mtimeMs: number; size: number };

export interface RecordInput {
  key: string;
  content: Buffer;
  by: VersionAuthor;
  at?: Date;
  seen?: { mtimeMs: number; size: number };
  /** Text, so the lines it added and removed can be counted. */
  textual: boolean;
}

export interface RecordResult {
  entry: VersionInfo;
  /** A new version, rather than the newest one confirmed or extended. */
  created: boolean;
}

export interface SweepOptions {
  now?: number;
  keepKey?: (key: string) => Promise<boolean>;
  /** How old an unnamed object must be before it is taken for unused. */
  graceMs?: number;
}

/** What keeps the versions. Today one implementation, on this workspace's own disk. */
export interface VersionStore {
  record(input: RecordInput): Promise<RecordResult>;
  markDeleted(input: { key: string; by: VersionAuthor; at?: Date }): Promise<boolean>;
  confirmSeen(key: string, seen: { mtimeMs: number; size: number }): Promise<void>;
  journal(key: string): Promise<Journal | null>;
  content(key: string, n: number): Promise<Buffer | null>;
  historyBytes(key: string): Promise<number>;
  forget(key: string, options?: { withChildren?: boolean }): Promise<number>;
  /** Every file with a history, and what it was on disk when last confirmed. Kept in memory after the first call. */
  tracked(): Promise<ReadonlyMap<string, Seen | null>>;
  usage(): Promise<{ bytes: number; files: number; versions: number }>;
  clear(options?: { olderThanDays?: number }): Promise<{ files: number; versions: number }>;
  /**
   * Applies the retention to every journal, drops the journals `keepKey` says no
   * longer belong to anything, and deletes the objects nothing names any more.
   */
  sweep(options?: SweepOptions): Promise<{ journals: number; dropped: number; objects: number }>;
}

export function versionsDir(): string {
  return path.join(process.cwd(), "data", "versions");
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function journalPath(key: string): string {
  const hash = sha256(key);
  return path.join(versionsDir(), "files", hash.slice(0, 2), `${hash}.json`);
}

function objectPath(sha: string): string {
  return path.join(versionsDir(), "objects", sha.slice(0, 2), `${sha}.gz`);
}

// One writer per file's journal, across every copy of this module the bundler makes.
const LOCKS_KEY = Symbol.for("eggent.fileVersions.locks");
function locks(): Map<string, Promise<unknown>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  if (!holder[LOCKS_KEY]) holder[LOCKS_KEY] = new Map();
  return holder[LOCKS_KEY] as Map<string, Promise<unknown>>;
}

export async function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const map = locks();
  const previous = map.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  map.set(key, tail);
  try {
    return await run;
  } finally {
    if (map.get(key) === tail) map.delete(key);
  }
}

async function writeAtomic(target: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.n === "number" &&
    typeof entry.at === "string" &&
    typeof entry.size === "number" &&
    (entry.sha === null || (typeof entry.sha === "string" && /^[0-9a-f]{64}$/.test(entry.sha))) &&
    Boolean(entry.by) && typeof (entry.by as Record<string, unknown>).kind === "string"
  );
}

async function loadJournal(key: string): Promise<Journal | null> {
  let raw: string;
  try {
    raw = await fs.readFile(journalPath(key), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Journal>;
    if (parsed.key !== key || !Array.isArray(parsed.versions)) return null;
    const versions = parsed.versions.filter(isEntry).sort((a, b) => a.n - b.n);
    const next = Math.max(typeof parsed.next === "number" ? parsed.next : 1, (versions[versions.length - 1]?.n ?? 0) + 1);
    return { v: 1, key, next, ...(parsed.seen ? { seen: parsed.seen } : {}), versions };
  } catch {
    return null;
  }
}

async function saveJournal(journal: Journal): Promise<void> {
  const target = journalPath(journal.key);
  if (journal.versions.length === 0) await fs.rm(target, { force: true });
  else await writeAtomic(target, `${JSON.stringify(journal)}\n`);
  await noteTracked(journal);
}

async function putObject(content: Buffer): Promise<string> {
  const sha = sha256(content);
  const target = objectPath(sha);
  try {
    // Already kept: touched, so a sweep running now does not take it for unused.
    const now = new Date();
    await fs.utimes(target, now, now);
    return sha;
  } catch {
    // Not there yet.
  }
  await writeAtomic(target, await gzip(content, { level: 6 }));
  return sha;
}

async function readObject(sha: string): Promise<Buffer | null> {
  try {
    return await gunzip(await fs.readFile(objectPath(sha)));
  } catch {
    return null;
  }
}

// Which files have a history, in memory: the pass that looks for changes made
// elsewhere asks every two minutes, and reading every journal to answer would
// cost more than the look itself.
const TRACKED_KEY = Symbol.for("eggent.fileVersions.tracked");
type TrackedIndex = { ready: Promise<Map<string, Seen | null>> | null };
function trackedHolder(): TrackedIndex {
  const holder = globalThis as unknown as Record<symbol, TrackedIndex | undefined>;
  if (!holder[TRACKED_KEY]) holder[TRACKED_KEY] = { ready: null };
  return holder[TRACKED_KEY]!;
}

async function noteTracked(journal: Journal): Promise<void> {
  const index = trackedHolder();
  if (!index.ready) return;
  const map = await index.ready;
  if (journal.versions.length === 0) map.delete(journal.key);
  else map.set(journal.key, journal.seen ?? null);
}

/**
 * Which versions a file keeps.
 *
 * A version's age is counted from when a newer one replaced it, not from when
 * it was made: the text a file held for three months until yesterday is
 * yesterday's text. Every version replaced within `keepDays` stays; of those
 * replaced up to `dailyDays` ago, one per day (the last of that day); older ones
 * go. The newest is never dropped - it is what the file is - unless it records
 * the file's deletion longer ago than everything else is kept.
 */
export function pruneVersions(entries: JournalEntry[], now: number, retention: VersionRetention): JournalEntry[] {
  if (entries.length === 0) return entries;
  const last = entries[entries.length - 1];
  const dailyMs = retention.dailyDays * DAY_MS;
  if (last.deleted && now - Date.parse(last.at) > dailyMs) return [];
  const keepMs = retention.keepDays * DAY_MS;
  const kept: JournalEntry[] = [];
  const lastOfDay = new Map<string, JournalEntry>();
  for (let index = 0; index < entries.length - 1; index += 1) {
    const entry = entries[index];
    const replacedAt = Date.parse(entries[index + 1].at);
    const age = now - replacedAt;
    if (!Number.isFinite(replacedAt) || age <= keepMs) {
      kept.push(entry);
    } else if (age <= dailyMs) {
      const day = new Date(replacedAt).toISOString().slice(0, 10);
      const known = lastOfDay.get(day);
      if (!known || entry.n > known.n) lastOfDay.set(day, entry);
    }
  }
  let result = [...kept, ...lastOfDay.values()].sort((a, b) => a.n - b.n);
  result.push(last);
  if (result.length > retention.maxPerFile) result = result.slice(result.length - retention.maxPerFile);
  // What a version was compared with may have gone: its counts are then about another pair.
  for (let index = 0; index < result.length; index += 1) {
    const comparedWith = entries[entries.indexOf(result[index]) - 1];
    if (comparedWith !== result[index - 1]) {
      delete result[index].added;
      delete result[index].removed;
    }
  }
  return result;
}

function journalObjects(journal: Journal): Set<string> {
  return new Set(journal.versions.map((entry) => entry.sha).filter((sha): sha is string => Boolean(sha)));
}

async function statsAgainst(previous: JournalEntry | undefined, content: Buffer, textual: boolean): Promise<{ added: number; removed: number } | null> {
  if (!textual || !previous || previous.deleted || !previous.sha) return null;
  if (content.length > MAX_STATS_BYTES || previous.size > MAX_STATS_BYTES) return null;
  const older = await readObject(previous.sha);
  if (!older) return null;
  return lineStats(older.toString("utf8"), content.toString("utf8"));
}

async function* walkJournals(): AsyncGenerator<string> {
  const root = path.join(versionsDir(), "files");
  let shards: string[];
  try {
    shards = await fs.readdir(root);
  } catch {
    return;
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".json")) yield path.join(root, shard, name);
    }
  }
}

async function keyOfJournalFile(file: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { key?: unknown };
    return typeof parsed.key === "string" ? parsed.key : null;
  } catch {
    return null;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) total += (await fs.stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

function createLocalVersionStore(): VersionStore {
  const prune = (journal: Journal, now = Date.now()) => {
    journal.versions = pruneVersions(journal.versions, now, versionRetention());
  };

  return {
    async record(input) {
      return withKeyLock(input.key, async () => {
        const journal = (await loadJournal(input.key)) ?? { v: 1, key: input.key, next: 1, versions: [] };
        const last = journal.versions[journal.versions.length - 1];
        const sha = sha256(input.content);
        if (last && !last.deleted && last.sha === sha) {
          if (input.seen && (journal.seen?.mtimeMs !== input.seen.mtimeMs || journal.seen?.size !== input.seen.size)) {
            journal.seen = input.seen;
            await saveJournal(journal);
          }
          return { entry: last, created: false };
        }

        await putObject(input.content);
        let at = input.at ?? new Date();
        // A time from another machine's clock is never put before what is already here.
        if (last && at.getTime() < Date.parse(last.at)) at = new Date(Date.parse(last.at) + 1);

        // A turn that writes the same file several times leaves one version: what it ended with.
        const extendsTurn =
          input.by.kind === "agent" &&
          Boolean(input.by.run) &&
          last !== undefined &&
          !last.deleted &&
          last.by.kind === "agent" &&
          last.by.run === input.by.run &&
          last.by.chat === input.by.chat;

        let entry: JournalEntry;
        if (extendsTurn && last) {
          entry = last;
          entry.sha = sha;
          entry.size = input.content.length;
          entry.at = at.toISOString();
          delete entry.added;
          delete entry.removed;
          const stats = await statsAgainst(journal.versions[journal.versions.length - 2], input.content, input.textual);
          if (stats) Object.assign(entry, stats);
        } else {
          entry = { n: journal.next, at: at.toISOString(), size: input.content.length, sha, by: { ...input.by } };
          journal.next += 1;
          const stats = await statsAgainst(last, input.content, input.textual);
          if (stats) Object.assign(entry, stats);
          journal.versions.push(entry);
        }
        if (input.seen) journal.seen = input.seen;
        prune(journal);
        await saveJournal(journal);
        return { entry, created: !extendsTurn };
      });
    },

    async markDeleted(input) {
      return withKeyLock(input.key, async () => {
        const journal = await loadJournal(input.key);
        const last = journal?.versions[journal.versions.length - 1];
        if (!journal || !last || last.deleted) return false;
        let at = input.at ?? new Date();
        if (at.getTime() < Date.parse(last.at)) at = new Date(Date.parse(last.at) + 1);
        journal.versions.push({ n: journal.next, at: at.toISOString(), size: 0, sha: null, by: { ...input.by }, deleted: true });
        journal.next += 1;
        delete journal.seen;
        prune(journal);
        await saveJournal(journal);
        return true;
      });
    },

    async confirmSeen(key, seen) {
      await withKeyLock(key, async () => {
        const journal = await loadJournal(key);
        if (!journal) return;
        journal.seen = seen;
        await saveJournal(journal);
      });
    },

    journal: loadJournal,

    async content(key, n) {
      const journal = await loadJournal(key);
      const entry = journal?.versions.find((candidate) => candidate.n === n);
      if (!entry?.sha) return null;
      return readObject(entry.sha);
    },

    async historyBytes(key) {
      const journal = await loadJournal(key);
      if (!journal) return 0;
      let total = (await fs.stat(journalPath(key)).catch(() => null))?.size ?? 0;
      for (const sha of journalObjects(journal)) total += (await fs.stat(objectPath(sha)).catch(() => null))?.size ?? 0;
      return total;
    },

    async forget(key, options = {}) {
      let removed = 0;
      const drop = async (target: string) =>
        withKeyLock(target, async () => {
          const journal = await loadJournal(target);
          if (!journal) return;
          journal.versions = [];
          await saveJournal(journal);
          removed += 1;
        });
      await drop(key);
      if (options.withChildren) {
        const prefix = key ? `${key}/` : "";
        for await (const file of walkJournals()) {
          const candidate = await keyOfJournalFile(file);
          if (candidate && candidate !== key && candidate.startsWith(prefix)) await drop(candidate);
        }
      }
      return removed;
    },

    async tracked() {
      const index = trackedHolder();
      if (!index.ready) {
        index.ready = (async () => {
          const map = new Map<string, Seen | null>();
          for await (const file of walkJournals()) {
            try {
              const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { key?: unknown; seen?: Seen; versions?: unknown[] };
              if (typeof parsed.key === "string" && Array.isArray(parsed.versions) && parsed.versions.length > 0) {
                map.set(parsed.key, parsed.seen && typeof parsed.seen.mtimeMs === "number" ? parsed.seen : null);
              }
            } catch {
              // Unreadable: the sweep removes it.
            }
          }
          return map;
        })();
        index.ready.catch(() => {
          index.ready = null;
        });
      }
      return index.ready;
    },

    async usage() {
      let files = 0;
      let versions = 0;
      for await (const file of walkJournals()) {
        try {
          const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { versions?: unknown[] };
          files += 1;
          versions += Array.isArray(parsed.versions) ? parsed.versions.length : 0;
        } catch {
          // A torn journal counts for nothing.
        }
      }
      return { bytes: await directoryBytes(versionsDir()), files, versions };
    },

    async clear(options = {}) {
      let files = 0;
      let versions = 0;
      const cutoff = options.olderThanDays === undefined ? null : Date.now() - options.olderThanDays * DAY_MS;
      for await (const file of walkJournals()) {
        const key = await keyOfJournalFile(file);
        if (!key) continue;
        await withKeyLock(key, async () => {
          const journal = await loadJournal(key);
          if (!journal) return;
          const before = journal.versions.length;
          if (cutoff === null) {
            journal.versions = [];
          } else {
            // Kept: the newest, and every version replaced after the cutoff.
            journal.versions = journal.versions.filter((_entry, index, all) =>
              index === all.length - 1 || Date.parse(all[index + 1].at) >= cutoff
            );
            if (journal.versions.length === 1 && journal.versions[0].deleted) journal.versions = [];
          }
          if (journal.versions.length === before) return;
          versions += before - journal.versions.length;
          if (journal.versions.length === 0) files += 1;
          await saveJournal(journal);
        });
      }
      // Older than a few seconds: an object a write made a moment ago may not be named yet.
      await sweep({ graceMs: 10_000 });
      return { files, versions };
    },

    sweep,
  };

  async function sweep(options: SweepOptions = {}): Promise<{ journals: number; dropped: number; objects: number }> {
    const now = options.now ?? Date.now();
    const graceMs = options.graceMs ?? OBJECT_GRACE_MS;
    const referenced = new Set<string>();
    let journals = 0;
    let dropped = 0;
    for await (const file of walkJournals()) {
      const key = await keyOfJournalFile(file);
      if (!key) {
        // Unreadable: not ours to understand, and holding nothing anyone can open.
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      await withKeyLock(key, async () => {
        const journal = await loadJournal(key);
        if (!journal) return;
        const before = journal.versions.length;
        if (options.keepKey && !(await options.keepKey(key))) journal.versions = [];
        else prune(journal, now);
        if (journal.versions.length !== before) {
          dropped += before - journal.versions.length;
          await saveJournal(journal);
        }
        if (journal.versions.length > 0) journals += 1;
        for (const sha of journalObjects(journal)) referenced.add(sha);
      });
    }

    let objects = 0;
    for (const area of ["objects", "files"] as const) {
      const root = path.join(versionsDir(), area);
      let shards: string[] = [];
      try {
        shards = await fs.readdir(root);
      } catch {
        // Nothing kept yet.
      }
      for (const shard of shards) {
        let names: string[];
        try {
          names = await fs.readdir(path.join(root, shard));
        } catch {
          continue;
        }
        for (const name of names) {
          const full = path.join(root, shard, name);
          const stat = await fs.stat(full).catch(() => null);
          if (!stat) continue;
          const young = now - stat.mtimeMs < graceMs;
          if (name.endsWith(".tmp")) {
            // A write that never finished.
            if (!young) await fs.rm(full, { force: true }).catch(() => undefined);
            continue;
          }
          if (area === "files") continue;
          const sha = name.replace(/\.gz$/, "");
          if (referenced.has(sha) || young) continue;
          await fs.rm(full, { force: true }).catch(() => undefined);
          objects += 1;
        }
        // Empty shards go; one with something left in it refuses, which is the point.
        await fs.rmdir(path.join(root, shard)).catch(() => undefined);
      }
    }
    return { journals, dropped, objects };
  }
}

const STORE_KEY = Symbol.for("eggent.fileVersions.store");

/** The store this workspace keeps its versions in. */
export function getVersionStore(): VersionStore {
  const holder = globalThis as unknown as Record<symbol, VersionStore | undefined>;
  if (!holder[STORE_KEY]) holder[STORE_KEY] = createLocalVersionStore();
  return holder[STORE_KEY] as VersionStore;
}
