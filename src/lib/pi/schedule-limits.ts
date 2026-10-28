/**
 * How many recurring tasks a workspace may keep, and how often each may run,
 * when the deployment's usage provider says so.
 *
 * Every run of a scheduled task wakes the workspace and starts a model turn, so
 * a deployment that pays for both may put a number on them; a workspace on its
 * own server has no provider and no limits. Core never says why a limit is what
 * it is: a refusal carries the provider's own sentence and link, the way a
 * locked model does, and falls back to a plain statement of the number.
 *
 * The rules are only ever about what is being added. A task that is already on
 * keeps running however the limits change - they cost nothing here to keep and
 * are not switched off - and so does an edit to its wording.
 *
 * Pure apart from the two readers at the bottom, so the rules are testable
 * without a runtime, a provider or a disk.
 */
import { Cron } from "croner";
import type { UsageLimits } from "@/lib/usage/usage-provider";

/**
 * One-time tasks waiting to fire, at most, while limits apply. They are not
 * counted against the provider's number - a reminder is not a monitor - but a
 * loop that schedules one a minute is still a loop.
 */
export const MAX_PENDING_ONE_TIME = 20;

/** The fields of a stored task these rules read. */
export interface LimitedJob {
  id?: string;
  schedule?: string;
  scheduleType?: string;
  intervalMs?: number;
  enabled?: boolean;
}

/** Which limit a change would cross. */
export type ScheduleLimitBreach = "schedules" | "scheduleMinMinutes" | "pendingOnce";

/** How many coming runs of a cron expression are looked at for its shortest gap. */
const CRON_RUNS_SAMPLED = 50;

export function isRecurringJob(job: LimitedJob): boolean {
  return job.scheduleType === "cron" || job.scheduleType === "interval" || (!job.scheduleType && Number(job.intervalMs) > 0);
}

function isOn(job: LimitedJob): boolean {
  return job.enabled !== false;
}

function isPendingOnce(job: LimitedJob, now: number): boolean {
  if (!isOn(job) || job.scheduleType !== "once") return false;
  const at = Date.parse(String(job.schedule));
  return !Number.isFinite(at) || at > now;
}

/**
 * The shortest time between two runs of a recurring task, or null for a
 * one-time task or a timing that cannot be read.
 *
 * For a cron expression that is the smallest gap among its coming runs, not the
 * gap between the first two: "at 9:00 and 9:05" runs twice in five minutes even
 * though it runs once a day.
 */
export function scheduleGapMs(job: LimitedJob): number | null {
  if (!isRecurringJob(job)) return null;
  if (job.scheduleType !== "cron") {
    const every = Number(job.intervalMs);
    return Number.isFinite(every) && every > 0 ? every : null;
  }
  let cron: Cron | null = null;
  try {
    cron = new Cron(String(job.schedule ?? ""), { paused: true });
    const runs = cron.nextRuns(CRON_RUNS_SAMPLED);
    let gap = Infinity;
    for (let index = 1; index < runs.length; index += 1) {
      gap = Math.min(gap, runs[index].getTime() - runs[index - 1].getTime());
    }
    return Number.isFinite(gap) ? gap : null;
  } catch {
    return null;
  } finally {
    cron?.stop();
  }
}

/** Limits that say something about schedules, or null when they say nothing. */
export function scheduleLimitsOf(limits: UsageLimits | null | undefined): UsageLimits | null {
  if (!limits) return null;
  return limits.schedules !== undefined || limits.scheduleMinMinutes !== undefined ? limits : null;
}

/**
 * Whether a task, as it will be after a change, crosses a limit.
 *
 * `others` is every other task in the workspace, `before` the task as it is
 * now (absent when it is being created) and `after` as it would be.
 * `timingChanged` says a new timing was asked for.
 */
export function judgeScheduleChange(input: {
  limits: UsageLimits | null | undefined;
  others: LimitedJob[];
  before?: LimitedJob | null;
  after: LimitedJob;
  timingChanged: boolean;
  now?: number;
}): ScheduleLimitBreach | null {
  const limits = scheduleLimitsOf(input.limits);
  if (!limits || !isOn(input.after)) return null;
  const now = input.now ?? Date.now();
  const before = input.before ?? null;

  if (!isRecurringJob(input.after)) {
    // Moving a one-time task that is already waiting adds nothing.
    if (before && isPendingOnce(before, now)) return null;
    const waiting = input.others.filter((job) => isPendingOnce(job, now)).length;
    return waiting >= MAX_PENDING_ONE_TIME ? "pendingOnce" : null;
  }

  // A task already on and recurring stays as counted as it was; only a new
  // timing for it is looked at.
  const alreadyCounted = Boolean(before && isOn(before) && isRecurringJob(before));
  if ((input.timingChanged || !alreadyCounted) && limits.scheduleMinMinutes !== undefined) {
    const gap = scheduleGapMs(input.after);
    if (gap !== null && gap < limits.scheduleMinMinutes * 60_000) return "scheduleMinMinutes";
  }
  if (!alreadyCounted && limits.schedules !== undefined) {
    const inUse = input.others.filter((job) => isOn(job) && isRecurringJob(job)).length;
    if (inUse >= limits.schedules) return "schedules";
  }
  return null;
}

/**
 * What the person is told about a crossed limit: the provider's sentence and
 * link when it gave them, else the number said plainly.
 */
export function scheduleLimitRefusal(breach: ScheduleLimitBreach, limits: UsageLimits | null | undefined): string {
  if (breach === "pendingOnce") {
    return `At most ${MAX_PENDING_ONE_TIME} one-time tasks can wait to run at once. Let one of them run, or delete one, before adding another.`;
  }
  const note = limits?.notes?.[breach]
    ?? (breach === "schedules"
      ? `This workspace can keep at most ${limits?.schedules ?? 0} recurring tasks switched on, and all of them are in use. Pause or delete one to add another.`
      : `In this workspace a recurring task can run at most once every ${limits?.scheduleMinMinutes ?? 0} minutes. Choose that or a longer interval.`);
  const manage = limits?.manage;
  if (!manage) return note;
  return manage.label ? `${note} ${manage.label}: ${manage.url}` : `${note} ${manage.url}`;
}

/** The provider's limits right now, or null when there is no provider or it set none. */
export async function currentScheduleLimits(): Promise<UsageLimits | null> {
  const { getUsageSnapshot, isUsageProviderConfigured } = await import("@/lib/usage/usage-provider");
  if (!isUsageProviderConfigured()) return null;
  return scheduleLimitsOf((await getUsageSnapshot())?.limits);
}
