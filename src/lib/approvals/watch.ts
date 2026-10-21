import fs from "node:fs/promises";
import { approvalsEnabled } from "@/lib/approvals/config";
import { fetchApprovals, reportApprovalOutdated } from "@/lib/approvals/client";
import { absoluteOfKey, currentStateOfKey } from "@/lib/approvals/files";
import { approvalIsOpen, type Approval } from "@/lib/approvals/types";
import { onHistoryChange } from "@/lib/files/versions/capture";

/**
 * The strict rule, kept from this side: any change to a file that is on
 * approval, or approved, voids that round.
 *
 * Only this workspace can see its files change, so it watches the ones it
 * sent: a change its history records is looked at a moment later, and every
 * minute each watched file is looked at anyway - files the history keeps no
 * versions of (a PDF, a picture) and changes made with the history switched
 * off are caught that way. What the file holds is compared with the bytes the
 * round was sent with, by hash, and a difference is reported to the service,
 * which closes the round; until the report lands it is tried again.
 *
 * Which files are watched is the service's answer about this workspace's own
 * approvals, refreshed every few minutes and whenever one is sent or taken
 * back from here.
 */

const TICK_MS = 60_000;
const REFRESH_MS = 5 * 60_000;
const FIRST_LOOK_MS = 15_000;
const AFTER_CHANGE_MS = 1_500;

interface Watched {
  id: string;
  round: number;
  sha: string;
  /** What the file was on disk when last found to hold the round's version. */
  seen: { mtimeMs: number; ctimeMs: number; size: number } | null;
}

interface WatchState {
  watched: Map<string, Watched>;
  refreshedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  soon: Map<string, ReturnType<typeof setTimeout>>;
  ticking: boolean;
}

const STATE_KEY = Symbol.for("eggent.approvals.watch");

function state(): WatchState {
  const holder = globalThis as unknown as Record<symbol, WatchState | undefined>;
  if (!holder[STATE_KEY]) {
    holder[STATE_KEY] = { watched: new Map(), refreshedAt: 0, timer: null, unsubscribe: null, soon: new Map(), ticking: false };
  }
  return holder[STATE_KEY] as WatchState;
}

/** Puts one of this workspace's approvals under watch, or takes it off when nothing about it is open any more. */
export function watchApproval(approval: Approval | null | undefined, key?: string | null): void {
  const fileKey = approval?.fileKey ?? key ?? null;
  if (!fileKey) return;
  const watched = state().watched;
  const latest = approval?.rounds[0];
  if (!approval || !approval.mine || !approvalIsOpen(approval) || !latest || latest.round !== approval.currentRound) {
    watched.delete(fileKey);
    return;
  }
  const known = watched.get(fileKey);
  const same = known && known.id === approval.id && known.round === latest.round && known.sha === latest.sha256;
  watched.set(fileKey, { id: approval.id, round: latest.round, sha: latest.sha256, seen: same ? known.seen : null });
}

/** The files watched now, for a test or a screen that wants to say so. */
export function watchedApprovalKeys(): string[] {
  return [...state().watched.keys()];
}

/** Asks the service which of this workspace's own approvals are open, and watches their files. */
export async function refreshWatchedApprovals(): Promise<void> {
  if (!approvalsEnabled()) return;
  const { approvals } = await fetchApprovals("sent", 200);
  const current = state().watched;
  const next = new Map<string, Watched>();
  for (const approval of approvals) {
    const latest = approval.rounds[0];
    if (!approval.mine || !approval.fileKey || !approvalIsOpen(approval) || !latest) continue;
    const known = current.get(approval.fileKey);
    const same = known && known.id === approval.id && known.round === latest.round && known.sha === latest.sha256;
    next.set(approval.fileKey, { id: approval.id, round: latest.round, sha: latest.sha256, seen: same ? known.seen : null });
  }
  state().watched = next;
  state().refreshedAt = Date.now();
}

/**
 * Looks at one watched file now: when it no longer holds the version its round
 * was sent with - changed, grown past what can be sent, unreadable or gone -
 * the service is told, and answers with the approval as it is after.
 */
export async function checkWatchedFile(key: string): Promise<Approval | null> {
  const entry = state().watched.get(key);
  if (!entry) return null;
  const now = await currentStateOfKey(key);
  if (now.kind === "file") {
    if (now.sha256 === entry.sha) {
      entry.seen = now.seen;
      return null;
    }
  }
  const sha = now.kind === "file" ? now.sha256 : null;
  const approval = await reportApprovalOutdated(entry.id, { round: entry.round, sha });
  watchApproval(approval, key);
  return approval;
}

/** Every watched file whose stat moved since it was last found unchanged; all of them on the first look. */
async function checkAll(): Promise<void> {
  for (const [key, entry] of [...state().watched]) {
    if (entry.seen) {
      const absolute = await absoluteOfKey(key);
      const stat = absolute ? await fs.lstat(absolute).catch(() => null) : null;
      if (stat && stat.isFile() && stat.size === entry.seen.size && stat.mtimeMs === entry.seen.mtimeMs && stat.ctimeMs === entry.seen.ctimeMs) continue;
    }
    await checkWatchedFile(key).catch((error) => {
      console.warn(`[approvals] could not look at ${key}: ${error instanceof Error ? error.message : error}`);
    });
  }
}

export async function approvalsWatchTick(options: { refresh?: boolean } = {}): Promise<void> {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    if (options.refresh || Date.now() - current.refreshedAt > REFRESH_MS) {
      await refreshWatchedApprovals().catch((error) => {
        console.warn(`[approvals] could not refresh what is on approval: ${error instanceof Error ? error.message : error}`);
      });
    }
    await checkAll();
  } finally {
    current.ticking = false;
  }
}

/** Started once per process, from the boot hook; nothing at all without the service. */
export function startApprovalsWatch(): void {
  if (!approvalsEnabled()) return;
  const current = state();
  if (current.timer) return;
  current.unsubscribe = onHistoryChange((key) => {
    if (!state().watched.has(key)) return;
    const soon = state().soon;
    clearTimeout(soon.get(key));
    const timer = setTimeout(() => {
      soon.delete(key);
      void checkWatchedFile(key).catch(() => undefined);
    }, AFTER_CHANGE_MS);
    (timer as { unref?: () => void }).unref?.();
    soon.set(key, timer);
  });
  const first = setTimeout(() => void approvalsWatchTick({ refresh: true }), FIRST_LOOK_MS);
  (first as { unref?: () => void }).unref?.();
  current.timer = setInterval(() => void approvalsWatchTick(), TICK_MS);
  (current.timer as { unref?: () => void }).unref?.();
}
