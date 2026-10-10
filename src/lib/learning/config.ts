import { getSettings } from "@/lib/storage/settings-store";

/**
 * How much the agent may keep, and how often it looks.
 *
 * Every limit here exists because the thing it limits is paid for somewhere.
 * The notes are read at the start of every conversation, so each character is
 * re-sent with every request. A review is a model call of its own. Neither is
 * large - which is the reason to say how large they may become, rather than
 * leave it to whatever a model decides is worth saying.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Read at call time so a test, or an operator restarting with new values, sees them. */
export function learningLimits() {
  return {
    /** What the person is like: name, work, how they want to be answered. */
    userChars: intFromEnv("EGGENT_LEARNED_USER_CHARS", 1400, 200, 6000),
    /** Facts about this workspace and lessons that will matter again. */
    notesChars: intFromEnv("EGGENT_LEARNED_NOTES_CHARS", 2200, 200, 8000),
    /** One note. A paragraph is a document, and documents are files. */
    entryChars: 300,
    /** Entries per list, so a limit in characters cannot become forty fragments. */
    maxEntries: 30,
    /** A learned skill: its SKILL.md body, and any one support file. */
    skillBodyChars: 12_000,
    skillFileChars: 20_000,
    skillFiles: 20,
    skillDescriptionChars: 300,
    skillNameChars: 48,
  };
}

export function reviewLimits() {
  return {
    /** Between two reviews in one workspace. */
    minGapMs: intFromEnv("EGGENT_LEARNING_MIN_GAP_SECONDS", 60, 0, 3600) * 1000,
    /** Reviews a workspace may start in a day. */
    dailyCap: intFromEnv("EGGENT_LEARNING_DAILY_CAP", 40, 1, 1000),
    /** A conversation nobody corrected is still looked at this often. */
    everyTurns: intFromEnv("EGGENT_LEARNING_EVERY_TURNS", 6, 2, 100),
    /** Tool calls in a turn before it counts as work worth turning into a skill. */
    effortToolCalls: intFromEnv("EGGENT_LEARNING_EFFORT_TOOL_CALLS", 6, 2, 50),
    /** What a review may do before it is stopped. */
    maxToolCalls: 8,
    timeoutMs: intFromEnv("EGGENT_LEARNING_TIMEOUT_SECONDS", 120, 10, 900) * 1000,
    /** What the reviewer is shown of the conversation. */
    digestChars: intFromEnv("EGGENT_LEARNING_DIGEST_CHARS", 7000, 1000, 30_000),
  };
}

export function curatorLimits() {
  return {
    /** Days without use before a learned skill is marked stale. */
    staleAfterDays: intFromEnv("EGGENT_LEARNING_STALE_DAYS", 30, 1, 3650),
    /** Days without use before it is moved aside. Never deleted. */
    archiveAfterDays: intFromEnv("EGGENT_LEARNING_ARCHIVE_DAYS", 90, 2, 3650),
    /** How often the housekeeping pass may run. */
    everyHours: intFromEnv("EGGENT_LEARNING_CURATOR_HOURS", 24, 1, 720),
  };
}

/** The deployment's own switch. Anything but an explicit "off" leaves it on. */
export function learningAvailable(): boolean {
  const raw = process.env.EGGENT_LEARNING?.trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

/** The person's switch, in Settings -> Memory. On unless they turned it off. */
export async function learningEnabled(): Promise<boolean> {
  if (!learningAvailable()) return false;
  try {
    const settings = await getSettings();
    return settings.learning?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * The model a review runs on, when the deployment names one.
 *
 * A review needs a competent reader and nothing more, so a deployment can point
 * it at something cheaper than the model the person chats with. Either
 * `provider/id` or a bare id; unknown names are ignored by the caller.
 */
export function reviewModelOverride(): string | undefined {
  return process.env.EGGENT_LEARNING_MODEL?.trim() || undefined;
}
