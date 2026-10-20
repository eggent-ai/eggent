import fs from "node:fs";
import path from "node:path";
import { outsideScanIntervalMs, versionsAvailable, versionsEnabled } from "@/lib/files/versions/config";
import { checkTracked, projectsDirectory } from "@/lib/files/versions/capture";
import { getVersionStore, versionsDir } from "@/lib/files/versions/store";

/**
 * What runs beside the workspace for file history.
 *
 * - Every two minutes the files that already have a history are looked at for
 *   a change nobody here made: the sync bringing a file edited on a computer,
 *   a command typed in the terminal, a program writing into the folder. Only
 *   their size and time are read unless those moved.
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

const STATE_KEY = Symbol.for("eggent.fileVersions.service");
interface ServiceState {
  started: boolean;
  cliDir: string | null | undefined;
  scanning: boolean;
}
function state(): ServiceState {
  const holder = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  if (!holder[STATE_KEY]) holder[STATE_KEY] = { started: false, cliDir: undefined, scanning: false };
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
export async function checkTrackedFiles(): Promise<{ checked: number; changed: number }> {
  const current = state();
  if (current.scanning || !(await versionsEnabled())) return { checked: 0, changed: 0 };
  current.scanning = true;
  let checked = 0;
  let changed = 0;
  try {
    const tracked = await getVersionStore().tracked();
    for (const key of [...tracked.keys()].slice(0, MAX_CHECKS_PER_PASS)) {
      const seen = tracked.get(key);
      const absolute = path.join(projectsDirectory(), ...key.split("/"));
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        stat = null;
      }
      checked += 1;
      // Recorded as deleted, and still not there.
      if (!stat && !seen) continue;
      // Unchanged since it was last confirmed: nothing is read.
      if (stat && seen && stat.mtimeMs === seen.mtimeMs && stat.size === seen.size) continue;
      const outcome = await checkTracked(key).catch(() => "same" as const);
      if (outcome === "changed" || outcome === "deleted") changed += 1;
    }
  } finally {
    current.scanning = false;
  }
  return { checked, changed };
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
  return getVersionStore().sweep({ keepKey: belongsToSomething });
}

export function startFileVersionsService(): void {
  const current = state();
  if (current.started) return;
  current.started = true;
  exportCliEnvironment();
  if (!versionsAvailable()) return;

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
  const where = "- File history: every change to a file in a project - saved by the user, written by you or by a command, or brought by the sync from a computer - is kept as a version, for 30 days by default. The user finds it under History beside a file open in the Files panel, where any two versions can be compared and any one restored.";
  if (!historyCliDir()) return `${where} Before telling the user a change cannot be undone, point them there.`;
  return `${where} You read it yourself with \`eggent-history list <file>\`, \`eggent-history show <file> <n>\` (that version, to standard output) and \`eggent-history diff <file> <a> [<b>]\`. To restore a version, write its content back; what it replaces stays in the history too. Before telling the user a change cannot be undone, look there.`;
}
