import fs from "node:fs";
import path from "node:path";
import { activeRunCount } from "@/lib/pi/active-runs";
import { getUsageSnapshot, isUsageProviderConfigured } from "@/lib/usage/usage-provider";
import { historyDiskShare, maxHistoryBytes, outsideScanIntervalMs, versionsAvailable, versionsEnabled } from "@/lib/files/versions/config";
import { checkTracked, onVersionRecorded, projectsDirectory } from "@/lib/files/versions/capture";
import { getVersionStore, versionsDir } from "@/lib/files/versions/store";

/**
 * What runs beside the workspace for file history.
 *
 * - Every two minutes the files that already have a history are looked at for
 *   a change nobody here made: the sync bringing a file edited on a computer,
 *   a command typed in the terminal, a program writing into the folder. Only
 *   their size and times are read unless those moved, a few thousand per pass,
 *   taking turns. Not while a turn runs: what its commands are writing is the
 *   agent's, and is credited to it when the turn ends.
 * - The history has a ceiling (historyCapBytes), checked a little after
 *   anything is recorded and once a day: past it, the versions replaced
 *   longest ago go first.
 * - Once a day the retention is applied, the history of a project that no
 *   longer exists is dropped, and objects nothing names any more are deleted.
 * - The `eggent-history` command is put on the PATH of everything this process
 *   starts - the agent's shell and the terminal panel - with the two folders it
 *   reads from in its environment.
 */

const CLI_NAME = "eggent-history";
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_AFTER_MS = 10 * 60 * 1000;
const MAX_CHECKS_PER_PASS = 4000;
const CAP_CHECK_DELAY_MS = 30_000;
// When the disk is this full, the history makes room for the files themselves.
const DISK_NEARLY_FULL = 0.9;
const NEARLY_FULL_SHARE = 0.1;

const STATE_KEY = Symbol.for("eggent.fileVersions.service");
interface ServiceState {
  started: boolean;
  cliDir: string | null | undefined;
  scanning: boolean;
  /** Where the next pass over tracked files starts, so every file gets its turn. */
  cursor: number;
  capTimer: ReturnType<typeof setTimeout> | null;
  enforcing: boolean;
}
function state(): ServiceState {
  const holder = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  if (!holder[STATE_KEY]) holder[STATE_KEY] = { started: false, cliDir: undefined, scanning: false, cursor: 0, capTimer: null, enforcing: false };
  return holder[STATE_KEY]!;
}

/**
 * Where the command lives: beside the app, in `scripts/bin`. The app is found
 * from its working directory (the image and a checkout run from it) or from the
 * path of the program that started it, which is inside the app's node_modules.
 */
export function historyCliDir(): string | null {
  const current = state();
  if (current.cliDir !== undefined) return current.cliDir;
  const candidates = [
    process.env.EGGENT_APP_ROOT,
    process.cwd(),
    ...(process.argv[1]?.includes(`${path.sep}node_modules${path.sep}`)
      ? [process.argv[1].slice(0, process.argv[1].indexOf(`${path.sep}node_modules${path.sep}`))]
      : []),
  ].filter((value): value is string => Boolean(value));
  current.cliDir = null;
  for (const root of candidates) {
    const dir = path.join(root, "scripts", "bin");
    try {
      fs.accessSync(path.join(dir, CLI_NAME), fs.constants.X_OK);
      current.cliDir = dir;
      break;
    } catch {
      // Not this one.
    }
  }
  return current.cliDir;
}

function exportCliEnvironment(): void {
  process.env.EGGENT_VERSIONS_DIR = versionsDir();
  process.env.EGGENT_PROJECTS_DIR = projectsDirectory();
  const dir = historyCliDir();
  if (!dir) return;
  const parts = (process.env.PATH || "").split(path.delimiter);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts.filter(Boolean)].join(path.delimiter);
}

/** One pass over the files with a history, for changes made elsewhere. */
export async function checkTrackedFiles(options: { evenDuringTurns?: boolean } = {}): Promise<{ checked: number; changed: number }> {
  const current = state();
  if (current.scanning || !(await versionsEnabled())) return { checked: 0, changed: 0 };
  if (!options.evenDuringTurns && activeRunCount() > 0) return { checked: 0, changed: 0 };
  current.scanning = true;
  let checked = 0;
  let changed = 0;
  try {
    const tracked = await getVersionStore().tracked();
    const keys = [...tracked.keys()];
    if (keys.length === 0) return { checked, changed };
    const start = current.cursor % keys.length;
    const count = Math.min(MAX_CHECKS_PER_PASS, keys.length);
    current.cursor = (start + count) % keys.length;
    for (let offset = 0; offset < count; offset += 1) {
      const key = keys[(start + offset) % keys.length];
      const seen = tracked.get(key);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(path.join(projectsDirectory(), ...key.split("/")));
      } catch {
        stat = null;
      }
      checked += 1;
      // Recorded as deleted, and still not there.
      if (!stat && !seen) continue;
      // Unchanged since it was last confirmed: nothing is read.
      if (stat && seen && stat.mtimeMs === seen.mtimeMs && stat.ctimeMs === seen.ctimeMs && stat.size === seen.size) continue;
      const outcome = await checkTracked(key).catch(() => "same" as const);
      if (outcome === "changed" || outcome === "deleted") changed += 1;
    }
  } finally {
    current.scanning = false;
  }
  return { checked, changed };
}

/** The disk the deployment says this workspace has, when it says so. */
async function reportedDisk(): Promise<{ used: number; limit: number } | null> {
  if (!isUsageProviderConfigured()) return null;
  try {
    const snapshot = await getUsageSnapshot();
    const meters = (snapshot?.meters ?? []).filter((meter) => meter.unit === "bytes" && meter.limit > 0);
    const disk = meters.find((meter) => meter.id === "storage") ?? meters[0];
    return disk ? { used: disk.used, limit: disk.limit } : null;
  } catch {
    return null;
  }
}

/**
 * The most the history may take: `EGGENT_VERSIONS_MAX_TOTAL_MB`, and no more
 * than a share of the disk the deployment reports (a quarter by default). When
 * that disk is nearly full the history shrinks to a tenth of it, so that the
 * versions of files are never what stops the work on the files themselves.
 */
export async function historyCapBytes(): Promise<number> {
  let cap = maxHistoryBytes();
  const disk = await reportedDisk();
  if (disk) {
    cap = Math.min(cap, Math.floor(disk.limit * historyDiskShare()));
    if (disk.used >= disk.limit * DISK_NEARLY_FULL) cap = Math.min(cap, Math.floor(disk.limit * NEARLY_FULL_SHARE));
  }
  return Math.max(0, cap);
}

/** Brings the history under its ceiling, if it is over. */
export async function enforceHistoryCap(): Promise<{ versions: number; files: number } | null> {
  const current = state();
  if (current.enforcing) return null;
  current.enforcing = true;
  try {
    const cap = await historyCapBytes();
    const store = getVersionStore();
    if ((await store.approximateBytes()) <= cap) return null;
    // A little under the ceiling, so the next few versions do not start the trimming again.
    const result = await store.trim(Math.floor(cap * 0.9));
    if (result.versions || result.files) {
      console.log(`[versions] over the ceiling of ${Math.round(cap / 1024 / 1024)} MB: ${result.versions} old version(s) and ${result.files} whole history(ies) let go of`);
    }
    return result;
  } finally {
    current.enforcing = false;
  }
}

function scheduleCapCheck(): void {
  const current = state();
  if (current.capTimer) return;
  current.capTimer = setTimeout(() => {
    current.capTimer = null;
    void enforceHistoryCap().catch((error) => console.warn("[versions] could not keep the history under its ceiling:", error));
  }, CAP_CHECK_DELAY_MS);
  (current.capTimer as { unref?: () => void }).unref?.();
}

/** Whether a history still belongs to something: a file in a project that was deleted belongs to nothing. */
async function belongsToSomething(key: string): Promise<boolean> {
  const slash = key.indexOf("/");
  if (slash <= 0) return true;
  try {
    return fs.statSync(path.join(projectsDirectory(), key.slice(0, slash))).isDirectory();
  } catch {
    return false;
  }
}

export async function sweepFileVersions(): Promise<{ journals: number; dropped: number; objects: number }> {
  const result = await getVersionStore().sweep({ keepKey: belongsToSomething });
  await enforceHistoryCap().catch(() => null);
  return result;
}

export function startFileVersionsService(): void {
  const current = state();
  if (current.started) return;
  current.started = true;
  exportCliEnvironment();
  if (!versionsAvailable()) return;
  onVersionRecorded(scheduleCapCheck);

  const scan = setInterval(() => {
    void checkTrackedFiles().catch((error) => console.warn("[versions] could not look for changes:", error));
  }, outsideScanIntervalMs());
  (scan as { unref?: () => void }).unref?.();

  const sweep = () => {
    void sweepFileVersions()
      .then((result) => {
        if (result.dropped || result.objects) console.log(`[versions] ${result.dropped} old version(s) and ${result.objects} unused object(s) removed; ${result.journals} file(s) have a history`);
      })
      .catch((error) => console.warn("[versions] the daily sweep failed:", error));
  };
  const first = setTimeout(() => {
    sweep();
    const daily = setInterval(sweep, SWEEP_EVERY_MS);
    (daily as { unref?: () => void }).unref?.();
  }, FIRST_SWEEP_AFTER_MS);
  (first as { unref?: () => void }).unref?.();
}

/** The line the agent is told about file history, or nothing when there is none. */
export function fileHistoryGuidance(): string {
  if (!versionsAvailable()) return "";
  const where = "- File history: once a file in a project has been changed - saved by the user, written by you or by a command, or brought by the sync from a computer - every change to it is kept as a version, for 30 days by default. The user finds it under History beside a file open in the Files panel, where any two versions can be compared and any one restored.";
  if (!historyCliDir()) return `${where} Before telling the user a change cannot be undone, point them there.`;
  return `${where} You read it yourself with \`eggent-history list <file>\`, \`eggent-history show <file> <n>\` (that version, to standard output) and \`eggent-history diff <file> <a> [<b>]\`. To restore a version, write its content back; what it replaces stays in the history too. Before telling the user a change cannot be undone, look there.`;
}
