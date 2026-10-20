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
 *
 * A version is dated by when it was seen here, never by the file's own time:
 * a copy restored with its old time (`cp -p`, an archive, the sync bringing an
 * old file) would otherwise date its own replacement months back, and the
 * retention would throw away the very version it replaced.
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const DAY_MS = 24 * 60 * 60 * 1000;
// An object nothing names yet may be one a write is about to name.
const OBJECT_GRACE_MS = 60 * 60 * 1000;
// What is let go of right after a deletion: objects older than this.
const QUICK_GRACE_MS = 5000;
// Lines added and removed are counted for text up to this size, briefly; larger, the list goes without.
const MAX_STATS_BYTES = 512 * 1024;
const STATS_TIMEOUT_MS = 150;

export interface JournalEntry extends VersionInfo {
  /** The object holding this version; null for a deletion. */
  sha: string | null;
}

/** What the file was on disk when its newest version was last confirmed: a change made elsewhere moves one of these. */
export type Seen = { mtimeMs: number; ctimeMs: number; size: number };

export interface Journal {
  v: 1;
  key: string;
  /** The number the next version gets. */
  next: number;
  seen?: Seen;
  versions: JournalEntry[];
}

export interface RecordInput {
  key: string;
  content: Buffer;
  by: VersionAuthor;
  /** The file's own modification time, for a state found here rather than made here. Shown, never used to date the version. */
  fileTime?: Date;
  seen?: Seen;
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
  markDeleted(input: { key: string; by: VersionAuthor }): Promise<boolean>;
  confirmSeen(key: string, seen: Seen): Promise<void>;
  journal(key: string): Promise<Journal | null>;
  content(key: string, n: number): Promise<Buffer | null>;
  historyBytes(key: string): Promise<number>;
  /** Drops a file's history (or everything under a folder) and lets go of the objects only it held. */
  forget(key: string, options?: { withChildren?: boolean }): Promise<number>;
  /** Every file with a history, and what it was on disk when last confirmed. Kept in memory after the first call. */
  tracked(): Promise<ReadonlyMap<string, Seen | null>>;
  usage(): Promise<{ bytes: number; files: number; versions: number }>;
  /** Bytes the store takes, from memory after the first count. */
  approximateBytes(): Promise<number>;
  clear(options?: { olderThanDays?: number }): Promise<{ files: number; versions: number }>;
  /**
   * Brings the store under `targetBytes`: the versions replaced longest ago go
   * first; when only each file's newest copy is left, the histories of the
   * files untouched longest go whole. What a file holds now is never touched.
   */
  trim(targetBytes: number): Promise<{ versions: number; files: number }>;
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

// Shared by every copy of this module the bundler makes: one writer per file's
// journal, one store, one count of its size, one index of tracked files.
interface StoreState {
  locks: Map<string, Promise<unknown>>;
  store: VersionStore | null;
  bytes: number | null;
  tracked: Promise<Map<string, Seen | null>> | null;
  collecting: Promise<number> | null;
  collectAgain: boolean;
}
const STATE_KEY = Symbol.for("eggent.fileVersions.storeState");
function state(): StoreState {
  const holder = globalThis as unknown as Record<symbol, StoreState | undefined>;
  if (!holder[STATE_KEY]) holder[STATE_KEY] = { locks: new Map(), store: null, bytes: null, tracked: null, collecting: null, collectAgain: false };
  return holder[STATE_KEY]!;
}

export async function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const map = state().locks;
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

function isSeen(value: unknown): value is Seen {
  const seen = value as Partial<Seen> | null;
  return Boolean(seen) && typeof seen?.mtimeMs === "number" && typeof seen?.size === "number" && typeof seen?.ctimeMs === "number";
}

function parseJournal(raw: string, key: string): Journal | null {
  const parsed = JSON.parse(raw) as Partial<Journal>;
  if (parsed.key !== key || !Array.isArray(parsed.versions)) return null;
  const versions = parsed.versions.filter(isEntry).sort((a, b) => a.n - b.n);
  const next = Math.max(typeof parsed.next === "number" ? parsed.next : 1, (versions[versions.length - 1]?.n ?? 0) + 1);
  return { v: 1, key, next, ...(isSeen(parsed.seen) ? { seen: parsed.seen } : {}), versions };
}

async function loadJournal(key: string): Promise<Journal | null> {
  let raw: string;
  try {
    raw = await fs.readFile(journalPath(key), "utf8");
  } catch {
    return null;
  }
  try {
    return parseJournal(raw, key);
  } catch {
    return null;
  }
}

async function noteTracked(journal: Journal): Promise<void> {
  const index = state().tracked;
  if (!index) return;
  const map = await index;
  if (journal.versions.length === 0) map.delete(journal.key);
  else map.set(journal.key, journal.seen ?? null);
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
  const packed = await gzip(content, { level: 6 });
  await writeAtomic(target, packed);
  const current = state();
  if (current.bytes !== null) current.bytes += packed.length;
  return sha;
}

async function readObject(sha: string): Promise<Buffer | null> {
  try {
    return await gunzip(await fs.readFile(objectPath(sha)));
  } catch {
    return null;
  }
}

/** The versions after `entries` lost some: one whose neighbour before it changed has counts about another pair. */
function dropStaleStats(before: JournalEntry[], after: JournalEntry[]): JournalEntry[] {
  for (let index = 0; index < after.length; index += 1) {
    const comparedWith = before[before.indexOf(after[index]) - 1];
    if (comparedWith !== after[index - 1]) {
      delete after[index].added;
      delete after[index].removed;
    }
  }
  return after;
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
  return dropStaleStats(entries, result);
}

function journalObjects(journal: Journal): Set<string> {
  return new Set(journal.versions.map((entry) => entry.sha).filter((sha): sha is string => Boolean(sha)));
}

async function statsAgainst(previous: JournalEntry | undefined, content: Buffer, textual: boolean): Promise<{ added: number; removed: number } | null> {
  if (!textual || !previous || previous.deleted || !previous.sha) return null;
  if (content.length > MAX_STATS_BYTES || previous.size > MAX_STATS_BYTES) return null;
  const older = await readObject(previous.sha);
  if (!older) return null;
  return lineStats(older.toString("utf8"), content.toString("utf8"), STATS_TIMEOUT_MS);
}

async function* walkArea(area: "files" | "objects"): AsyncGenerator<{ file: string; name: string; shard: string }> {
  const root = path.join(versionsDir(), area);
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
    for (const name of names) yield { file: path.join(root, shard, name), name, shard: path.join(root, shard) };
  }
}

/** Every journal on disk with its key; one that is not JSON is reported as such, one that cannot be read now is skipped. */
async function* walkJournals(): AsyncGenerator<{ file: string; key: string | null; broken: boolean }> {
  for await (const { file, name } of walkArea("files")) {
    if (!name.endsWith(".json")) continue;
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      // Unreadable for now (a descriptor limit, a disk hiccup): not the same as broken.
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { key?: unknown };
      yield { file, key: typeof parsed.key === "string" ? parsed.key : null, broken: typeof parsed.key !== "string" };
    } catch {
      yield { file, key: null, broken: true };
    }
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

/**
 * Deletes the objects no journal names, older than `graceMs`, and temporary
 * files a write never finished. One at a time: a call while one runs asks for
 * one more pass after it rather than a second one beside it.
 */
async function collectGarbage(graceMs: number): Promise<number> {
  const current = state();
  if (current.collecting) {
    current.collectAgain = true;
    return current.collecting;
  }
  const run = async (): Promise<number> => {
    let deleted = 0;
    do {
      current.collectAgain = false;
      const now = Date.now();
      const referenced = new Set<string>();
      for await (const { key } of walkJournals()) {
        if (!key) continue;
        const journal = await loadJournal(key);
        if (journal) for (const sha of journalObjects(journal)) referenced.add(sha);
      }
      for (const area of ["objects", "files"] as const) {
        const shards = new Set<string>();
        for await (const { file, name, shard } of walkArea(area)) {
          shards.add(shard);
          const stat = await fs.stat(file).catch(() => null);
          if (!stat) continue;
          const young = now - stat.mtimeMs < graceMs;
          if (name.endsWith(".tmp")) {
            if (now - stat.mtimeMs > OBJECT_GRACE_MS) await fs.rm(file, { force: true }).catch(() => undefined);
            continue;
          }
          if (area === "files") continue;
          if (young || referenced.has(name.replace(/\.gz$/, ""))) continue;
          await fs.rm(file, { force: true }).catch(() => undefined);
          if (current.bytes !== null) current.bytes = Math.max(0, current.bytes - stat.size);
          deleted += 1;
        }
        // Empty shards go; one with something left in it refuses, which is the point.
        for (const shard of shards) await fs.rmdir(shard).catch(() => undefined);
      }
    } while (current.collectAgain);
    return deleted;
  };
  current.collecting = run().finally(() => {
    current.collecting = null;
  });
  return current.collecting;
}

function createLocalVersionStore(): VersionStore {
  const prune = (journal: Journal, now = Date.now()) => {
    journal.versions = pruneVersions(journal.versions, now, versionRetention());
  };

  const store: VersionStore = {
    async record(input) {
      return withKeyLock(input.key, async () => {
        const journal = (await loadJournal(input.key)) ?? { v: 1, key: input.key, next: 1, versions: [] };
        const last = journal.versions[journal.versions.length - 1];
        const sha = sha256(input.content);
        if (last && !last.deleted && last.sha === sha) {
          if (input.seen && (journal.seen?.mtimeMs !== input.seen.mtimeMs || journal.seen?.ctimeMs !== input.seen.ctimeMs || journal.seen?.size !== input.seen.size)) {
            journal.seen = input.seen;
            await saveJournal(journal);
          }
          return { entry: last, created: false };
        }

        await putObject(input.content);
        let at = new Date();
        // A clock that stepped back never puts a version before the one it follows.
        if (last && at.getTime() <= Date.parse(last.at)) at = new Date(Date.parse(last.at) + 1);

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
          entry = {
            n: journal.next,
            at: at.toISOString(),
            size: input.content.length,
            sha,
            by: { ...input.by },
            ...(input.fileTime && Number.isFinite(input.fileTime.getTime()) ? { fileTime: input.fileTime.toISOString() } : {}),
          };
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
        let at = new Date();
        if (at.getTime() <= Date.parse(last.at)) at = new Date(Date.parse(last.at) + 1);
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
        for await (const { key: candidate } of walkJournals()) {
          if (candidate && candidate !== key && candidate.startsWith(prefix)) await drop(candidate);
        }
      }
      // Deleting to make room has to make room: what only these versions held goes now.
      if (removed > 0) await collectGarbage(QUICK_GRACE_MS);
      return removed;
    },

    async tracked() {
      const current = state();
      if (!current.tracked) {
        current.tracked = (async () => {
          const map = new Map<string, Seen | null>();
          for await (const { key } of walkJournals()) {
            if (!key) continue;
            const journal = await loadJournal(key);
            if (journal && journal.versions.length > 0) map.set(key, journal.seen ?? null);
          }
          return map;
        })();
        current.tracked.catch(() => {
          current.tracked = null;
        });
      }
      return current.tracked;
    },

    async usage() {
      let files = 0;
      let versions = 0;
      for await (const { key } of walkJournals()) {
        if (!key) continue;
        const journal = await loadJournal(key);
        if (!journal) continue;
        files += 1;
        versions += journal.versions.length;
      }
      const bytes = await directoryBytes(versionsDir());
      state().bytes = bytes;
      return { bytes, files, versions };
    },

    async approximateBytes() {
      const current = state();
      if (current.bytes === null) current.bytes = await directoryBytes(versionsDir());
      return current.bytes;
    },

    async clear(options = {}) {
      let files = 0;
      let versions = 0;
      const cutoff = options.olderThanDays === undefined ? null : Date.now() - options.olderThanDays * DAY_MS;
      for await (const { key } of walkJournals()) {
        if (!key) continue;
        await withKeyLock(key, async () => {
          const journal = await loadJournal(key);
          if (!journal) return;
          const before = journal.versions;
          if (cutoff === null) {
            journal.versions = [];
          } else {
            // Kept: the newest, and every version replaced after the cutoff.
            const kept = before.filter((_entry, index, all) => index === all.length - 1 || Date.parse(all[index + 1].at) >= cutoff);
            journal.versions = kept.length === 1 && kept[0].deleted ? [] : dropStaleStats(before, kept);
          }
          if (journal.versions.length === before.length) return;
          versions += before.length - journal.versions.length;
          if (journal.versions.length === 0) files += 1;
          await saveJournal(journal);
        });
      }
      await collectGarbage(QUICK_GRACE_MS);
      state().bytes = null;
      return { files, versions };
    },

    async trim(targetBytes) {
      const current = state();
      if ((await store.approximateBytes()) <= targetBytes) return { versions: 0, files: 0 };
      // A plan made on a picture of the whole store, then applied journal by journal under its lock.
      const journals = new Map<string, Journal>();
      for await (const { key } of walkJournals()) {
        if (!key) continue;
        const journal = await loadJournal(key);
        if (journal && journal.versions.length > 0) journals.set(key, journal);
      }
      const references = new Map<string, number>();
      for (const journal of journals.values()) {
        for (const entry of journal.versions) if (entry.sha) references.set(entry.sha, (references.get(entry.sha) ?? 0) + 1);
      }
      const sizes = new Map<string, number>();
      for (const sha of references.keys()) sizes.set(sha, (await fs.stat(objectPath(sha)).catch(() => null))?.size ?? 0);
      let total = await directoryBytes(versionsDir());
      const release = (sha: string | null) => {
        if (!sha) return;
        const left = (references.get(sha) ?? 1) - 1;
        references.set(sha, left);
        if (left === 0) total -= sizes.get(sha) ?? 0;
      };

      // First the versions replaced longest ago, whatever file they belong to.
      const candidates: Array<{ key: string; entry: JournalEntry; replacedAt: number }> = [];
      for (const [key, journal] of journals) {
        journal.versions.forEach((entry, index, all) => {
          if (index < all.length - 1) candidates.push({ key, entry, replacedAt: Date.parse(all[index + 1].at) || 0 });
        });
      }
      candidates.sort((a, b) => a.replacedAt - b.replacedAt);
      const dropped = new Map<string, Set<number>>();
      let versions = 0;
      for (const candidate of candidates) {
        if (total <= targetBytes) break;
        if (!dropped.has(candidate.key)) dropped.set(candidate.key, new Set());
        dropped.get(candidate.key)!.add(candidate.entry.n);
        release(candidate.entry.sha);
        versions += 1;
      }
      // Then, if each file's newest copy alone is still too much, the histories of the files untouched longest.
      const wholly = new Set<string>();
      if (total > targetBytes) {
        const byAge = [...journals.values()].sort((a, b) => Date.parse(a.versions[a.versions.length - 1].at) - Date.parse(b.versions[b.versions.length - 1].at));
        for (const journal of byAge) {
          if (total <= targetBytes) break;
          wholly.add(journal.key);
          const already = dropped.get(journal.key);
          for (const entry of journal.versions) if (!already?.has(entry.n)) release(entry.sha);
        }
      }

      for (const [key, numbers] of dropped) {
        if (wholly.has(key)) continue;
        await withKeyLock(key, async () => {
          const journal = await loadJournal(key);
          if (!journal) return;
          const before = journal.versions;
          const last = before[before.length - 1];
          const kept = before.filter((entry) => entry === last || !numbers.has(entry.n));
          if (kept.length === before.length) return;
          journal.versions = dropStaleStats(before, kept);
          await saveJournal(journal);
        });
      }
      for (const key of wholly) {
        await withKeyLock(key, async () => {
          const journal = await loadJournal(key);
          if (!journal) return;
          journal.versions = [];
          await saveJournal(journal);
        });
      }
      await collectGarbage(QUICK_GRACE_MS);
      current.bytes = null;
      return { versions, files: wholly.size };
    },

    async sweep(options = {}) {
      const now = options.now ?? Date.now();
      const graceMs = options.graceMs ?? OBJECT_GRACE_MS;
      let journals = 0;
      let dropped = 0;
      for await (const { file, key, broken } of walkJournals()) {
        if (!key) {
          // Not JSON, or not ours: nothing anyone can open. Left a while first: it may be mid-write.
          const stat = await fs.stat(file).catch(() => null);
          if (broken && stat && now - stat.mtimeMs > OBJECT_GRACE_MS) await fs.rm(file, { force: true }).catch(() => undefined);
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
        });
      }
      const objects = await collectGarbage(graceMs);
      state().bytes = null;
      return { journals, dropped, objects };
    },
  };
  return store;
}

/** The store this workspace keeps its versions in. */
export function getVersionStore(): VersionStore {
  const current = state();
  if (!current.store) current.store = createLocalVersionStore();
  return current.store;
}
