import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getWorkDir, isHiddenFileName } from "@/lib/storage/project-store";
import { isSecretFileName, pathIsSensitive } from "@/lib/files/zip-walk";
import { openPlainFile } from "@/lib/files/safe-open";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { maxVersionedFileBytes, versionsEnabled } from "@/lib/files/versions/config";
import { comparisonOf, versionedKindOf, type VersionedKind } from "@/lib/files/versions/rules";
import { getVersionStore, type Seen } from "@/lib/files/versions/store";
import type { VersionAuthor, VersionInfo } from "@/lib/files/versions/shape";

/**
 * Deciding when a file gets a new version, and reading what it holds.
 *
 * A file changes in five ways here: the person saves it in the editor, the agent
 * writes or edits it, the agent runs a command that rewrites it, it is uploaded,
 * or it changes with nobody here watching - the sync with a computer, a command
 * typed in the terminal, another program. The first four are caught where they
 * happen and know who did it. The fifth is noticed afterwards: before the next
 * write here (the state found is kept first, as made "outside"), and by a pass
 * over the files that already have a history (service.ts).
 *
 * A history begins with a file's first change, not with the file: a file that
 * is only created - uploaded, generated, written once - has nothing to go back
 * to, and a copy of it would only double what it takes on the disk. Its first
 * change keeps what it held before ("earlier") and what it holds after.
 */

/** A file a history can be kept for: where it is, and what its history is called. */
export interface VersionTarget {
  absolute: string;
  /** Its path under the projects folder, with forward slashes: the same file has one key whichever scope names it. */
  key: string;
  name: string;
  kind: VersionedKind | "sniff";
}

// The agent's own bookkeeping, at the top of the orchestrator's folder or of a project's.
const INTERNAL_TOP_LEVEL = new Set([
  "memory.md", "learned.md", ".mcp.json", "mcp.json", "model.json", "project.json",
  "skills", ".pi", "tools", ".eggent-tools",
]);
const SKIPPED_SEGMENTS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".cache", ".next", ".pi",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".gradle", ".idea", ".stversions",
  // A company's shared folders are mounted here: `.shared/<name>` at the top and
  // `<project>/shared/<name>` in a project (see isVersionablePath). They are the
  // company's files, not this workspace's: a history of them here would fill this
  // workspace's disk and outlive a grant taken back.
  ".shared",
]);
const SNIFF_MAX_BYTES = 1024 * 1024;
// What a command line names is held in memory until the command has run.
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 5000;
const MAX_SCAN_DEPTH = 6;
const START_SLACK_MS = 2000;

/** The projects folder as configured: the orchestrator's working directory. */
export function projectsDirectory(): string {
  return path.resolve(getWorkDir(null));
}

let realRoot: { of: string; real: string } | null = null;

/** The same folder with every link on its way resolved, which is what a real path is compared with. */
async function projectsRoot(): Promise<string> {
  const configured = projectsDirectory();
  if (realRoot?.of === configured) return realRoot.real;
  await fs.mkdir(configured, { recursive: true }).catch(() => undefined);
  realRoot = { of: configured, real: await fs.realpath(configured).catch(() => configured) };
  return realRoot.real;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Whether a path under the projects folder may have a history at all, whatever the file is. */
export function isVersionablePath(key: string): boolean {
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  if (INTERNAL_TOP_LEVEL.has(segments[0].toLowerCase())) return false;
  // In a project's own folder, one level down: its notes, its skills, its tools.
  if (segments.length > 1 && INTERNAL_TOP_LEVEL.has(segments[1].toLowerCase())) return false;
  if (segments.some((segment) => SKIPPED_SEGMENTS.has(segment.toLowerCase()) || isHiddenFileName(segment))) return false;
  // A company folder granted to one project is mounted at `<project>/shared/<name>`.
  if (segments.length >= 4 && segments[1] === "shared") return false;
  // A history of a credential would keep it after the person deleted it.
  if (pathIsSensitive(key) || isSecretFileName(segments[segments.length - 1])) return false;
  return true;
}

/** The file at an absolute path, if it is one a history is kept for. Works for a file that is not there any more. */
export async function versionTarget(absolute: string): Promise<VersionTarget | null> {
  const root = await projectsRoot();
  const resolved = path.resolve(absolute);
  const name = path.basename(resolved);
  const kind = versionedKindOf(name);
  if (!kind) return null;
  let parent: string;
  try {
    parent = await fs.realpath(path.dirname(resolved));
  } catch {
    // Its folder is gone too: judged by the path as written.
    parent = path.dirname(resolved);
    if (!inside(parent, root) && !inside(parent, projectsDirectory())) return null;
    parent = inside(parent, root) ? parent : path.join(root, path.relative(projectsDirectory(), parent));
  }
  if (!inside(parent, root)) return null;
  const key = path.relative(root, path.join(parent, name)).split(path.sep).join("/");
  if (!key || key.startsWith("..") || !isVersionablePath(key)) return null;
  return { absolute: path.join(parent, name), key, name, kind };
}

/** The file a scope and a path in it name, as the dashboard names files. */
export async function versionTargetFor(projectId: string, filePath: string): Promise<VersionTarget | null> {
  let workDir: string;
  try {
    workDir = path.resolve(getWorkDir(projectId));
  } catch {
    return null;
  }
  const absolute = path.resolve(workDir, filePath);
  if (absolute === workDir || !absolute.startsWith(workDir + path.sep)) return null;
  return versionTarget(absolute);
}

type ReadResult =
  | { kind: "file"; content: Buffer; seen: Seen; fileTime: Date }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "unreadable" };

function seenOf(stat: { mtimeMs: number; ctimeMs: number; size: number }): Seen {
  return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
}

/** What the file holds, read through a handle checked to be the plain file inside the folder. */
async function readTarget(target: VersionTarget, limit = maxVersionedFileBytes()): Promise<ReadResult> {
  let stat;
  try {
    stat = await fs.lstat(target.absolute);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  // A link is not followed: it may lead out of the folder. A second name is the same door.
  if (!stat.isFile() || stat.nlink > 1) return { kind: "unreadable" };
  if (stat.size > limit || (target.kind === "sniff" && stat.size > SNIFF_MAX_BYTES)) return { kind: "too-large" };
  const handle = await openPlainFile(target.absolute, { root: await projectsRoot() });
  if (!handle) return { kind: "unreadable" };
  try {
    const opened = await handle.stat();
    if (opened.size > limit) return { kind: "too-large" };
    const content = await handle.readFile();
    // A file without an extension is text only if it reads as text.
    if (target.kind === "sniff" && content.subarray(0, 8192).includes(0)) return { kind: "unreadable" };
    return { kind: "file", content, seen: seenOf(opened), fileTime: opened.mtime };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Many writes in a moment - a turn that writes ten files - make one event per project.
const PUBLISH_DELAY_MS = 400;
const PENDING_KEY = Symbol.for("eggent.fileVersions.pendingEvents");
type PendingEvents = Map<string, { keys: Set<string>; timer: ReturnType<typeof setTimeout> }>;
function pendingEvents(): PendingEvents {
  const holder = globalThis as unknown as Record<symbol, PendingEvents | undefined>;
  if (!holder[PENDING_KEY]) holder[PENDING_KEY] = new Map();
  return holder[PENDING_KEY]!;
}

/** The project a key belongs to, as the dashboard names it: the first folder, or the orchestrator for a file at the top. */
function scopeOfKey(key: string): string | null {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : null;
}

function announce(key: string): void {
  const scope = scopeOfKey(key);
  const bucket = scope ?? "";
  const pending = pendingEvents();
  const known = pending.get(bucket);
  if (known) {
    known.keys.add(key);
    return;
  }
  const keys = new Set([key]);
  const timer = setTimeout(() => {
    pending.delete(bucket);
    publishUiSyncEvent({ topic: "files", projectId: scope, reason: "file_version", paths: [...keys] });
  }, PUBLISH_DELAY_MS);
  (timer as { unref?: () => void }).unref?.();
  pending.set(bucket, { keys, timer });
}

// Something was recorded: the service checks the history's size against its ceiling a moment later.
const RECORDED_KEY = Symbol.for("eggent.fileVersions.onRecorded");
function noteRecorded(): void {
  const listener = (globalThis as unknown as Record<symbol, (() => void) | undefined>)[RECORDED_KEY];
  listener?.();
}
export function onVersionRecorded(listener: () => void): void {
  (globalThis as unknown as Record<symbol, (() => void) | undefined>)[RECORDED_KEY] = listener;
}

/** Keeps a state found on disk, as made before the history began or outside it. */
async function keepFound(target: VersionTarget, content: Buffer, seen: Seen, fileTime: Date): Promise<"kept" | "unchanged"> {
  const store = getVersionStore();
  const journal = await store.journal(target.key);
  const last = journal?.versions[journal.versions.length - 1];
  if (last && !last.deleted && last.sha === sha256(content)) return "unchanged";
  const result = await store.record({
    key: target.key,
    content,
    by: { kind: journal && journal.versions.length > 0 ? "outside" : "earlier" },
    fileTime,
    seen,
    textual: comparisonOf(target.name) === "text",
  });
  if (result.created) {
    announce(target.key);
    noteRecorded();
  }
  return "kept";
}

/**
 * What became of a file's current state before something here writes over it.
 *
 * - `kept`: it is in the history now; `unchanged`: it was already.
 * - `missing`: there is no file yet; `not-versioned` / `off`: no history is kept for it.
 * - `too-large`, `unreadable`: there is a file and it could not be kept. A
 *   restore must not write over it then, or "what the file holds stays in the
 *   history" would not be true.
 */
export type BeforeStatus = "kept" | "unchanged" | "missing" | "not-versioned" | "off" | "too-large" | "unreadable";

export async function captureBefore(absolute: string): Promise<BeforeStatus> {
  if (!(await versionsEnabled())) return "off";
  const target = await versionTarget(absolute);
  if (!target) return "not-versioned";
  const read = await readTarget(target);
  if (read.kind !== "file") return read.kind;
  return keepFound(target, read.content, read.seen, read.fileTime);
}

/**
 * Keep what the file holds after a write here, made by `by`. A file that is
 * gone is recorded as deleted. `onlyIfTracked`: only for a file whose history
 * has begun - a file the write created has none, and gets none.
 */
export async function captureAfter(absolute: string, by: VersionAuthor, options: { onlyIfTracked?: boolean } = {}): Promise<VersionInfo | null> {
  if (!(await versionsEnabled())) return null;
  const target = await versionTarget(absolute);
  if (!target) return null;
  if (options.onlyIfTracked && !(await getVersionStore().journal(target.key))) return null;
  return captureTarget(target, by);
}

async function captureTarget(target: VersionTarget, by: VersionAuthor): Promise<VersionInfo | null> {
  const store = getVersionStore();
  const read = await readTarget(target);
  if (read.kind === "missing") {
    if (await store.markDeleted({ key: target.key, by })) announce(target.key);
    return null;
  }
  if (read.kind !== "file") return null;
  const result = await store.record({ key: target.key, content: read.content, by, seen: read.seen, textual: comparisonOf(target.name) === "text" });
  announce(target.key);
  if (result.created) noteRecorded();
  return result.entry;
}

/** Whether a file has a history yet. */
export async function hasHistory(absolute: string): Promise<boolean> {
  const target = await versionTarget(absolute);
  return Boolean(target && (await getVersionStore().journal(target.key)));
}

/**
 * A file that already has a history, looked at for a change nobody here made.
 * Its stat is compared first, so an unchanged file costs one call.
 *
 * "too-large" and "unreadable" mean the file has moved on to something the
 * history cannot keep: its newest version is no longer what it holds, and
 * whoever shows the history must not say it is.
 */
export type TrackedOutcome = "same" | "changed" | "deleted" | "gone" | "too-large" | "unreadable";

export async function checkTracked(key: string): Promise<TrackedOutcome> {
  const root = await projectsRoot();
  const target = await versionTarget(path.join(root, ...key.split("/")));
  const store = getVersionStore();
  const journal = await store.journal(key);
  const last = journal?.versions[journal.versions.length - 1];
  // A folder on the way that has become a link leads to another file: that file is not this history's.
  if (!target || target.key !== key || !journal || !last) return "gone";
  let stat;
  try {
    stat = await fs.lstat(target.absolute);
  } catch {
    if (last.deleted) return "same";
    await store.markDeleted({ key, by: { kind: "outside" } });
    announce(key);
    return "deleted";
  }
  // A folder or a link where the file was: what is there is not the newest version.
  if (!stat.isFile()) return last.deleted ? "same" : "unreadable";
  const seen = journal.seen;
  if (!last.deleted && seen && seen.mtimeMs === stat.mtimeMs && seen.ctimeMs === stat.ctimeMs && seen.size === stat.size) return "same";
  const read = await readTarget(target);
  if (read.kind === "too-large" || read.kind === "unreadable") return read.kind;
  if (read.kind !== "file") return "same";
  if (!last.deleted && last.sha === sha256(read.content)) {
    await store.confirmSeen(key, read.seen);
    return "same";
  }
  await store.record({ key, content: read.content, by: { kind: "outside" }, fileTime: read.fileTime, seen: read.seen, textual: comparisonOf(target.name) === "text" });
  announce(key);
  noteRecorded();
  return "changed";
}

/**
 * What a turn's commands changed among the files that already have a history:
 * every one under the folder the turn worked in whose status changed while it
 * ran. The status time (ctime), not the modification time, which a command can
 * set back (`cp -p`, unpacking an archive). A file with no history yet is left
 * to the next change made where it can be seen (a command that names it, the
 * editor, the agent's own tools). In the orchestrator's folder, which holds
 * every project and whatever the sync brings, only the files lying directly in
 * it are looked at - the same rule the card of an answer's files keeps.
 */
export async function captureRunChanges(input: { cwd: string; since: number; by: VersionAuthor }): Promise<number> {
  if (!(await versionsEnabled())) return 0;
  const root = await projectsRoot();
  let cwd: string;
  try {
    cwd = await fs.realpath(input.cwd);
  } catch {
    return 0;
  }
  if (!inside(cwd, root)) return 0;
  const store = getVersionStore();
  const tracked = await store.tracked();
  if (tracked.size === 0) return 0;
  const maxDepth = cwd === root ? 0 : MAX_SCAN_DEPTH;
  const found: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || visited >= MAX_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES) return;
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_SEGMENTS.has(entry.name.toLowerCase()) || isHiddenFileName(entry.name)) continue;
        if (depth + 1 > maxDepth) continue;
        await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        const key = path.relative(root, absolute).split(path.sep).join("/");
        if (!tracked.has(key)) continue;
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat && Math.max(stat.mtimeMs, stat.ctimeMs) >= input.since - START_SLACK_MS) found.push(absolute);
      }
    }
  };
  await walk(cwd, 0);
  let recorded = 0;
  for (const absolute of found.sort()) {
    const target = await versionTarget(absolute);
    if (!target) continue;
    if (await captureTarget(target, input.by)) recorded += 1;
  }
  return recorded;
}

const PATH_LIKE = /(["'`])((?:(?!\1)[^\n])+)\1|[^\s"'`;|&<>()]+/g;
const MAX_COMMAND_PATHS = 20;
const MAX_SNAPSHOT_TOTAL = 16 * 1024 * 1024;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Files a command names: `sed -i … notes.md`, `python fill.py contract.docx`,
 * a script that opens `Document("contract.docx")`. Only names that would get a
 * history, and at most a few: this runs before every command.
 */
export function pathsInCommand(command: string, cwd: string): string[] {
  const found: string[] = [];
  for (const match of command.matchAll(PATH_LIKE)) {
    if (found.length >= MAX_COMMAND_PATHS) break;
    const raw = (match[2] ?? match[0]).trim().replace(/^[([{,=]+|[)\]},:;]+$/g, "");
    if (!raw || raw.length > 300 || !raw.includes(".")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) continue;
    if (versionedKindOf(raw) !== "text" && versionedKindOf(raw) !== "document") continue;
    const absolute = path.resolve(cwd, expandHome(raw));
    if (!found.includes(absolute)) found.push(absolute);
  }
  return found;
}

/** A file a command named, as it was just before the command ran - in memory, not yet in the history. */
export interface CommandSnapshot {
  target: VersionTarget;
  /** Null: there was no file. */
  content: Buffer | null;
  seen: Seen | null;
  fileTime: Date | null;
}

/**
 * What the files a command names hold before it runs, kept in memory. Most
 * commands only read (`cat`, `head`, `grep`): a copy kept for each of them would
 * only fill the disk, so the history gets one only if the command changed the
 * file (settleCommandSnapshots).
 */
export async function snapshotsForCommand(command: string, cwd: string): Promise<CommandSnapshot[]> {
  if (!command || !(await versionsEnabled())) return [];
  const snapshots: CommandSnapshot[] = [];
  let total = 0;
  for (const absolute of pathsInCommand(command, cwd)) {
    const target = await versionTarget(absolute);
    if (!target) continue;
    const read = await readTarget(target, Math.min(SNAPSHOT_MAX_BYTES, MAX_SNAPSHOT_TOTAL - total));
    if (read.kind === "missing") snapshots.push({ target, content: null, seen: null, fileTime: null });
    else if (read.kind === "file") {
      total += read.content.length;
      snapshots.push({ target, content: read.content, seen: read.seen, fileTime: read.fileTime });
    }
  }
  return snapshots;
}

/**
 * After the command: a file it changed keeps what it held before (now that it
 * is worth keeping) and what it holds now; a file it deleted keeps what it held
 * and a record of the deletion. A file it created gets nothing - a history
 * begins with a change.
 */
export async function settleCommandSnapshots(snapshots: CommandSnapshot[], by: VersionAuthor): Promise<void> {
  const store = getVersionStore();
  for (const snapshot of snapshots) {
    if (!snapshot.content || !snapshot.seen || !snapshot.fileTime) continue;
    const now = await readTarget(snapshot.target);
    if (now.kind === "file" && sha256(now.content) === sha256(snapshot.content)) continue;
    if (now.kind !== "file" && now.kind !== "missing") continue;
    await keepFound(snapshot.target, snapshot.content, snapshot.seen, snapshot.fileTime);
    if (now.kind === "missing") {
      if (await store.markDeleted({ key: snapshot.target.key, by })) announce(snapshot.target.key);
    } else {
      await captureTarget(snapshot.target, by);
    }
  }
}

/** A write that would leave the folder, or go through a link: refused, and said as such. */
export class OutsideFolderError extends Error {
  constructor() {
    super("outside the folder");
  }
}

/**
 * Write a file inside a folder without following a link at its name, and in
 * one step: the new content goes to a temporary file beside it, which then
 * takes the file's place. A reader - the sync, an editor, the agent - sees the
 * old file or the new one, never half of it. A file nobody may write to stays
 * that way: the rename would otherwise replace it as if it were not read-only.
 */
export async function writeFileInside(absolute: string, content: Buffer | string, root: string): Promise<void> {
  const realRootDir = await fs.realpath(root);
  const resolved = path.resolve(absolute);
  // The nearest folder that exists is judged before anything is made under it:
  // a link on the way would have the new folders made wherever it points.
  let existing = path.dirname(resolved);
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      const up = path.dirname(existing);
      if (up === existing) throw new OutsideFolderError();
      existing = up;
    }
  }
  if (!inside(await fs.realpath(existing), realRootDir)) throw new OutsideFolderError();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const parent = await fs.realpath(path.dirname(resolved));
  if (!inside(parent, realRootDir)) throw new OutsideFolderError();
  const target = path.join(parent, path.basename(resolved));
  let mode = 0o644;
  try {
    const current = await fs.lstat(target);
    if (!current.isFile()) throw new OutsideFolderError();
    mode = current.mode & 0o777;
    if ((mode & 0o200) === 0) throw Object.assign(new Error("read-only"), { code: "EACCES" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temp = path.join(parent, `.${path.basename(resolved)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Drop the history of a file, or of everything under a folder, when the person deletes it here. */
export async function forgetHistory(projectId: string, filePath: string, options: { folder: boolean }): Promise<void> {
  let workDir: string;
  try {
    workDir = path.resolve(getWorkDir(projectId));
  } catch {
    return;
  }
  const absolute = path.resolve(workDir, filePath);
  if (!inside(absolute, workDir)) return;
  const root = await projectsRoot();
  let key: string;
  try {
    const parent = await fs.realpath(path.dirname(absolute));
    key = path.relative(root, path.join(parent, path.basename(absolute))).split(path.sep).join("/");
  } catch {
    key = path.relative(projectsDirectory(), absolute).split(path.sep).join("/");
  }
  if (key.startsWith("..")) return;
  await getVersionStore().forget(key, { withChildren: options.folder });
}
