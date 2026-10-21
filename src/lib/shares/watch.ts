import fs from "node:fs/promises";
import { onHistoryChange } from "@/lib/files/versions/capture";
import { absoluteOfKey } from "@/lib/files/project-keys";
import { sharesEnabled } from "@/lib/shares/config";
import { fetchShares, reportSharedFileChanged } from "@/lib/shares/client";

/**
 * Telling the people a file is shared with that it changed.
 *
 * Only this workspace sees its files change, so it watches the ones it shared:
 * a change its history records is reported a moment later, and every couple of
 * minutes each shared file is looked at anyway - a file the history keeps no
 * versions of (a PDF, a picture) changes too. A report is only "look at it":
 * the service reads the file itself and marks it new for its people only when
 * what it holds is different from what it knew, so a report too many costs
 * nothing.
 *
 * Which files are shared is the service's answer about this workspace,
 * refreshed every few minutes and whenever a file is shared or stopped from
 * here.
 */

const TICK_MS = 2 * 60_000;
const REFRESH_MS = 5 * 60_000;
const FIRST_LOOK_MS = 20_000;
const AFTER_CHANGE_MS = 1_500;

type Seen = { mtimeMs: number; ctimeMs: number; size: number } | null;

interface WatchState {
  /** Shared file keys, and what each was on disk when last reported or found unchanged. */
  watched: Map<string, Seen>;
  refreshedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  soon: Map<string, ReturnType<typeof setTimeout>>;
  ticking: boolean;
}

const STATE_KEY = Symbol.for("eggent.shares.watch");

function state(): WatchState {
  const holder = globalThis as unknown as Record<symbol, WatchState | undefined>;
  if (!holder[STATE_KEY]) {
    holder[STATE_KEY] = { watched: new Map(), refreshedAt: 0, timer: null, unsubscribe: null, soon: new Map(), ticking: false };
  }
  return holder[STATE_KEY] as WatchState;
}

/** A file was shared from here, or stopped being shared. */
export function watchSharedKey(key: string, shared: boolean): void {
  const watched = state().watched;
  if (!shared) watched.delete(key);
  else if (!watched.has(key)) watched.set(key, null);
}

/** The files watched now, for a test or a screen that wants to say so. */
export function watchedSharedKeys(): string[] {
  return [...state().watched.keys()];
}

async function statOf(key: string): Promise<Seen> {
  const absolute = await absoluteOfKey(key);
  const stat = absolute ? await fs.lstat(absolute).catch(() => null) : null;
  return stat ? { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size } : null;
}

/** Asks the service which of this workspace's files are shared, and watches them. */
export async function refreshSharedKeys(): Promise<void> {
  if (!sharesEnabled()) return;
  const { mine } = await fetchShares();
  const current = state().watched;
  const next = new Map<string, Seen>();
  for (const share of mine) {
    if (share.fileKey) next.set(share.fileKey, current.get(share.fileKey) ?? null);
  }
  state().watched = next;
  state().refreshedAt = Date.now();
}

/** Reports one shared file now; the service decides whether it is news. */
export async function reportSharedKey(key: string): Promise<boolean> {
  if (!state().watched.has(key)) return false;
  const seen = await statOf(key);
  const { changed } = await reportSharedFileChanged(key);
  if (state().watched.has(key)) state().watched.set(key, seen);
  return changed;
}

/** Every watched file whose stat moved since it was last reported; all of them on the first look. */
async function checkAll(): Promise<void> {
  for (const [key, seen] of [...state().watched]) {
    const now = await statOf(key);
    if (seen && now && now.size === seen.size && now.mtimeMs === seen.mtimeMs && now.ctimeMs === seen.ctimeMs) continue;
    if (seen === null && now === null) continue;
    await reportSharedKey(key).catch((error) => {
      console.warn(`[shares] could not report ${key}: ${error instanceof Error ? error.message : error}`);
    });
  }
}

export async function sharesWatchTick(options: { refresh?: boolean } = {}): Promise<void> {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    if (options.refresh || Date.now() - current.refreshedAt > REFRESH_MS) {
      await refreshSharedKeys().catch((error) => {
        console.warn(`[shares] could not refresh what is shared: ${error instanceof Error ? error.message : error}`);
      });
    }
    await checkAll();
  } finally {
    current.ticking = false;
  }
}

/** Started once per process, from the boot hook; nothing at all without the service. */
export function startSharesWatch(): void {
  if (!sharesEnabled()) return;
  const current = state();
  if (current.timer) return;
  current.unsubscribe = onHistoryChange((key) => {
    if (!state().watched.has(key)) return;
    const soon = state().soon;
    clearTimeout(soon.get(key));
    const timer = setTimeout(() => {
      soon.delete(key);
      void reportSharedKey(key).catch(() => undefined);
    }, AFTER_CHANGE_MS);
    (timer as { unref?: () => void }).unref?.();
    soon.set(key, timer);
  });
  const first = setTimeout(() => void sharesWatchTick({ refresh: true }), FIRST_LOOK_MS);
  (first as { unref?: () => void }).unref?.();
  current.timer = setInterval(() => void sharesWatchTick(), TICK_MS);
  (current.timer as { unref?: () => void }).unref?.();
}
