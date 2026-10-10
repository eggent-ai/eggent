import fs from "fs/promises";
import path from "path";
import { reviewLimits } from "@/lib/learning/config";
import { learningStateDir } from "@/lib/learning/paths";

/**
 * How often the agent has looked back, so it does not look back too often.
 *
 * Counters per chat - turns since the last look - and two limits for the
 * workspace as a whole: a gap between looks and a number of looks a day. The
 * limits are not a measure of how much there is to learn. They are what stands
 * between a conversation that happens to contain a keyword and a model call
 * after every sentence.
 *
 * Kept on globalThis because routes are compiled separately and a plain module
 * variable would be a separate set of counters in each; and written to the
 * machine's own data/learning so a restart does not make every chat due at once.
 */

interface ChatCounter {
  turns: number;
  sinceReview: number;
  lastReviewAt?: number;
  touchedAt: number;
}

interface ReviewState {
  version: 1;
  day: string;
  runsToday: number;
  lastRunAt: number;
  chats: Record<string, ChatCounter>;
}

interface StateHolder {
  __eggentLearningState?: Promise<ReviewState>;
  __eggentLearningStateWrite?: Promise<void>;
}

const FILE_NAME = "state.json";
const MAX_CHATS = 300;

function stateFile(): string {
  return path.join(learningStateDir(), FILE_NAME);
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function fresh(now: number): ReviewState {
  return { version: 1, day: dayOf(now), runsToday: 0, lastRunAt: 0, chats: {} };
}

async function loadFromDisk(now: number): Promise<ReviewState> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), "utf-8")) as Partial<ReviewState>;
    if (parsed?.version === 1 && parsed.chats && typeof parsed.chats === "object") {
      return {
        version: 1,
        day: typeof parsed.day === "string" ? parsed.day : dayOf(now),
        runsToday: Number.isFinite(parsed.runsToday) ? Number(parsed.runsToday) : 0,
        lastRunAt: Number.isFinite(parsed.lastRunAt) ? Number(parsed.lastRunAt) : 0,
        chats: parsed.chats,
      };
    }
  } catch {
    // First run, or a file we cannot read: start over.
  }
  return fresh(now);
}

function state(now = Date.now()): Promise<ReviewState> {
  const holder = globalThis as unknown as StateHolder;
  holder.__eggentLearningState ??= loadFromDisk(now);
  return holder.__eggentLearningState;
}

/** Drops the in-memory copy, so the next read comes from disk. For tests. */
export function resetReviewState(): void {
  const holder = globalThis as unknown as StateHolder;
  delete holder.__eggentLearningState;
  delete holder.__eggentLearningStateWrite;
}

function persist(current: ReviewState): Promise<void> {
  const holder = globalThis as unknown as StateHolder;
  const snapshot = JSON.stringify(current);
  holder.__eggentLearningStateWrite = (holder.__eggentLearningStateWrite ?? Promise.resolve())
    .then(async () => {
      const file = stateFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, "utf-8");
      await fs.rename(temp, file);
    })
    .catch((error) => {
      console.warn("Could not save the learning state:", error);
    });
  return holder.__eggentLearningStateWrite;
}

function rollDay(current: ReviewState, now: number): void {
  const today = dayOf(now);
  if (current.day !== today) {
    current.day = today;
    current.runsToday = 0;
  }
}

function prune(current: ReviewState): void {
  const ids = Object.keys(current.chats);
  if (ids.length <= MAX_CHATS) return;
  ids
    .sort((a, b) => current.chats[a].touchedAt - current.chats[b].touchedAt)
    .slice(0, ids.length - MAX_CHATS)
    .forEach((id) => delete current.chats[id]);
}

/** One more turn finished in this chat. Returns where the chat stands. */
export async function countTurn(chatId: string, now = Date.now()): Promise<{ turns: number; sinceReview: number }> {
  const current = await state(now);
  const counter = (current.chats[chatId] ??= { turns: 0, sinceReview: 0, touchedAt: now });
  counter.turns += 1;
  counter.sinceReview += 1;
  counter.touchedAt = now;
  prune(current);
  await persist(current);
  return { turns: counter.turns, sinceReview: counter.sinceReview };
}

/** Whether a review may start now, whatever the chat has said. */
export async function reviewAllowed(
  now = Date.now(),
  options: { ignoreGap?: boolean } = {}
): Promise<{ ok: true } | { ok: false; why: "gap" | "daily" }> {
  const current = await state(now);
  rollDay(current, now);
  const limits = reviewLimits();
  if (current.runsToday >= limits.dailyCap) return { ok: false, why: "daily" };
  if (!options.ignoreGap && current.lastRunAt && now - current.lastRunAt < limits.minGapMs) return { ok: false, why: "gap" };
  return { ok: true };
}

/** A review began for this chat. */
export async function noteReviewStarted(chatId: string, now = Date.now()): Promise<void> {
  const current = await state(now);
  rollDay(current, now);
  current.runsToday += 1;
  current.lastRunAt = now;
  const counter = (current.chats[chatId] ??= { turns: 0, sinceReview: 0, touchedAt: now });
  counter.sinceReview = 0;
  counter.lastReviewAt = now;
  counter.touchedAt = now;
  await persist(current);
}

/** For the tests: where the counters stand. */
export async function peekState(): Promise<ReviewState> {
  return structuredClone(await state());
}
