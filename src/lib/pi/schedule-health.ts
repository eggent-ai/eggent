import fs from "fs/promises";
import path from "path";

/**
 * How a scheduled task has been doing, so a task that cannot run stops asking.
 *
 * A task that keeps meeting the same wall - the model service refusing every
 * request, the disk full - used to fire on its schedule forever: one workspace
 * was refused 371 times in eight days, every refusal delivered to the person's
 * Telegram as the day's report, and nothing ever switched the task off. This
 * counts consecutive runs that could not be carried out, tells the person once,
 * and pauses the task when it is clear that the next run will fail the same way.
 *
 * Two kinds of failure are kept apart because they mean different things. A
 * refusal is the deployment saying no to every request and is not going to
 * change by itself minutes later; three in a row is enough. A failure is
 * anything else that ended a run - a provider error, a helper that hit its turn
 * limit - which may be a bad hour rather than a bad task, so it takes more.
 *
 * The counters are the machine's own: the task lives in a store that may be
 * copied to another computer, and the other computer's runs are not these.
 * They are kept in data/schedules, outside what is shared, and on globalThis
 * because routes are compiled separately and a module variable would be one set
 * of counters in each.
 */

export type RunOutcome = "ok" | "refused" | "failed";

export interface JobHealth {
  kind: "refused" | "failed" | null;
  /** Consecutive runs of this kind, counting the latest. */
  streak: number;
  lastAt: string;
  detail?: string;
}

export interface HealthLimits {
  pauseAfterRefused: number;
  pauseAfterFailed: number;
}

/** What the person is told about this run. */
export type RunDelivery =
  /** The run's own report goes out as it always did. */
  | "report"
  /** There is no report worth sending: say that the run did not finish. */
  | "notice"
  /** The task has just been paused: say so and how to resume it. */
  | "pause-notice"
  /** The same thing is happening again; the run is kept in its chat and nothing is sent. */
  | "silent";

export interface RunVerdict {
  health: JobHealth;
  pause: boolean;
  delivery: RunDelivery;
}

const DEFAULT_LIMITS: HealthLimits = { pauseAfterRefused: 3, pauseAfterFailed: 5 };

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function healthLimits(env: Record<string, string | undefined> = process.env): HealthLimits {
  return {
    pauseAfterRefused: positiveInt(env.EGGENT_SCHEDULE_PAUSE_AFTER_REFUSED, DEFAULT_LIMITS.pauseAfterRefused),
    pauseAfterFailed: positiveInt(env.EGGENT_SCHEDULE_PAUSE_AFTER_FAILED, DEFAULT_LIMITS.pauseAfterFailed),
  };
}

const MAX_DETAIL_CHARS = 600;

function clip(detail: string | undefined): string | undefined {
  const cleaned = detail?.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_DETAIL_CHARS ? `${cleaned.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…` : cleaned;
}

/** What one more run does to the record and to the person. Pure. */
export function judgeRun(
  previous: JobHealth | undefined,
  outcome: RunOutcome,
  options: { now?: Date; detail?: string; hasReport: boolean; limits?: HealthLimits }
): RunVerdict {
  const now = (options.now ?? new Date()).toISOString();
  if (outcome === "ok") {
    return { health: { kind: null, streak: 0, lastAt: now }, pause: false, delivery: "report" };
  }

  const streak = (previous?.kind === outcome ? previous.streak : 0) + 1;
  const health: JobHealth = { kind: outcome, streak, lastAt: now, ...(clip(options.detail) ? { detail: clip(options.detail) } : {}) };
  const limits = options.limits ?? healthLimits();
  const limit = outcome === "refused" ? limits.pauseAfterRefused : limits.pauseAfterFailed;

  if (streak >= limit) return { health, pause: true, delivery: "pause-notice" };
  // The first of a streak is news. A refused run's report already is the
  // refusal, in the person's language; a failed run may have no report at all.
  if (streak === 1) return { health, pause: false, delivery: outcome === "failed" && !options.hasReport ? "notice" : "report" };
  return { health, pause: false, delivery: "silent" };
}

interface HealthFile {
  version: 1;
  jobs: Record<string, JobHealth>;
}

interface Holder {
  __eggentScheduleHealth?: Promise<HealthFile>;
  __eggentScheduleHealthWrite?: Promise<void>;
}

const MAX_JOBS = 400;

function healthPath(): string {
  return path.join(process.cwd(), "data", "schedules", "health.json");
}

async function load(): Promise<HealthFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(healthPath(), "utf-8")) as Partial<HealthFile>;
    if (parsed?.version === 1 && parsed.jobs && typeof parsed.jobs === "object") {
      return { version: 1, jobs: parsed.jobs };
    }
  } catch {
    // First run, or a file we cannot read: start over.
  }
  return { version: 1, jobs: {} };
}

function state(): Promise<HealthFile> {
  const holder = globalThis as unknown as Holder;
  holder.__eggentScheduleHealth ??= load();
  return holder.__eggentScheduleHealth;
}

/** Drops the in-memory copy, so the next read comes from disk. For tests. */
export function resetScheduleHealth(): void {
  const holder = globalThis as unknown as Holder;
  delete holder.__eggentScheduleHealth;
  delete holder.__eggentScheduleHealthWrite;
}

function persist(current: HealthFile): Promise<void> {
  const holder = globalThis as unknown as Holder;
  const snapshot = JSON.stringify(current);
  holder.__eggentScheduleHealthWrite = (holder.__eggentScheduleHealthWrite ?? Promise.resolve())
    .then(async () => {
      const file = healthPath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, "utf-8");
      await fs.rename(temp, file);
    })
    .catch((error) => {
      console.warn("Could not save the schedule health:", error);
    });
  return holder.__eggentScheduleHealthWrite;
}

function prune(current: HealthFile): void {
  const keys = Object.keys(current.jobs);
  if (keys.length <= MAX_JOBS) return;
  keys
    .sort((a, b) => current.jobs[a].lastAt.localeCompare(current.jobs[b].lastAt))
    .slice(0, keys.length - MAX_JOBS)
    .forEach((key) => delete current.jobs[key]);
}

/** Key for one task: the session that owns the store and the task's id. */
export function healthKey(sessionId: string, jobId: string): string {
  return `${sessionId}:${jobId}`;
}

/** Records a finished run and says what to do about it. */
export async function recordRunOutcome(
  key: string,
  outcome: RunOutcome,
  options: { detail?: string; hasReport: boolean; now?: Date; limits?: HealthLimits }
): Promise<RunVerdict> {
  const current = await state();
  const verdict = judgeRun(current.jobs[key], outcome, options);
  if (verdict.health.kind === null && !current.jobs[key]) return verdict;
  if (verdict.health.kind === null) delete current.jobs[key];
  else current.jobs[key] = verdict.health;
  prune(current);
  await persist(current);
  return verdict;
}

export async function readJobHealth(key: string): Promise<JobHealth | undefined> {
  return (await state()).jobs[key];
}

/** A task that was resumed, deleted or changed starts again from nothing. */
export async function forgetJobHealth(key: string): Promise<void> {
  const current = await state();
  if (!current.jobs[key]) return;
  delete current.jobs[key];
  await persist(current);
}
