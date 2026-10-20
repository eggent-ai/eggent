import { getSettings } from "@/lib/storage/settings-store";
import type { VersionRetention } from "@/lib/files/versions/shape";

/**
 * The limits of file history, from the environment.
 *
 * Every version is kept for `EGGENT_VERSIONS_KEEP_DAYS` (30) after a newer one
 * replaced it, then one a day until `EGGENT_VERSIONS_DAILY_DAYS` (90), and never
 * more than `EGGENT_VERSIONS_MAX_PER_FILE` (200) for one file. A file over
 * `EGGENT_VERSIONS_MAX_FILE_MB` (10) gets none. `EGGENT_VERSIONS=off` turns the
 * whole thing off for a deployment; the workspace's own switch is in Settings.
 */

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function versionsAvailable(): boolean {
  const raw = process.env.EGGENT_VERSIONS?.trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false" && raw !== "no";
}

export function versionRetention(): VersionRetention {
  const keepDays = positiveNumber(process.env.EGGENT_VERSIONS_KEEP_DAYS, 30);
  return {
    keepDays,
    dailyDays: Math.max(keepDays, positiveNumber(process.env.EGGENT_VERSIONS_DAILY_DAYS, 90)),
    maxPerFile: Math.max(2, Math.floor(positiveNumber(process.env.EGGENT_VERSIONS_MAX_PER_FILE, 200))),
  };
}

export function maxVersionedFileBytes(): number {
  return Math.floor(positiveNumber(process.env.EGGENT_VERSIONS_MAX_FILE_MB, 10) * 1024 * 1024);
}

/** How often files that already have a history are looked at for changes nobody here made. */
export function outsideScanIntervalMs(): number {
  return Math.floor(positiveNumber(process.env.EGGENT_VERSIONS_SCAN_SECONDS, 120) * 1000);
}

// Read on every write a tool makes, so not from disk every time.
const SWITCH_TTL_MS = 5000;
let switchCache: { at: number; value: boolean } | null = null;

/** The workspace's own switch, under Settings -> General. On unless turned off. */
export async function versionsSwitchedOn(): Promise<boolean> {
  const now = Date.now();
  if (switchCache && now - switchCache.at < SWITCH_TTL_MS) return switchCache.value;
  let value = true;
  try {
    value = (await getSettings()).fileHistory?.enabled !== false;
  } catch {
    // Unreadable settings keep the default.
  }
  switchCache = { at: now, value };
  return value;
}

/** For the settings route, after a change: the next write reads the new value. */
export function forgetVersionsSwitch(): void {
  switchCache = null;
}

export async function versionsEnabled(): Promise<boolean> {
  return versionsAvailable() && (await versionsSwitchedOn());
}
