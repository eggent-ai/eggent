import fs from "fs/promises";
import path from "path";
import { curatorLimits } from "@/lib/learning/config";
import { appendJournal } from "@/lib/learning/journal";
import { learningStateDir, skillsArchiveDir } from "@/lib/learning/paths";
import { listOrchestratorSkills } from "@/lib/learning/skills";
import type { LearnedSkillView } from "@/lib/learning/types";

/**
 * Which of the agent's own skills are in use, and the housekeeping that follows.
 *
 * A library that only grows becomes a library nobody reads: every skill is a
 * line in the prompt of every conversation, so an unused one is a standing cost
 * with no return. The pass below is deliberately plain - it looks at dates, not
 * at meaning - and deliberately gentle: an unused skill is first marked, then
 * moved to `skills/.archive/`, and nothing is ever deleted. It touches only
 * skills the agent wrote, never ones the person made or installed.
 *
 * The counters are this computer's own (data/learning), not shared: two
 * computers keeping one counter file would only make conflict copies. A skill
 * that arrives from the other computer has no counters here, so its age is
 * taken from its own file instead.
 */

interface SkillUsage {
  createdAt?: string;
  patchedAt?: string;
  lastUsedAt?: string;
  useCount: number;
  patchCount: number;
  state?: "stale";
}

interface UsageFile {
  skills: Record<string, SkillUsage>;
  curatorRanAt?: string;
}

const FILE_NAME = "skills.json";

function usagePath(): string {
  return path.join(learningStateDir(), FILE_NAME);
}

interface LockHolder {
  __eggentLearningUsageLock?: Promise<unknown>;
}

function withLock<T>(work: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as LockHolder;
  const previous = holder.__eggentLearningUsageLock ?? Promise.resolve();
  const next = previous.then(work, work);
  holder.__eggentLearningUsageLock = next.catch(() => undefined);
  return next;
}

async function readUsage(): Promise<UsageFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(usagePath(), "utf-8")) as Partial<UsageFile>;
    return { skills: parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {}, curatorRanAt: parsed.curatorRanAt };
  } catch {
    return { skills: {} };
  }
}

async function writeUsage(usage: UsageFile): Promise<void> {
  const file = usagePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(usage, null, 2), "utf-8");
  await fs.rename(temp, file);
}

function entryFor(usage: UsageFile, name: string): SkillUsage {
  usage.skills[name] ??= { useCount: 0, patchCount: 0 };
  return usage.skills[name];
}

/** The agent made or changed a skill. */
export function noteSkillWritten(name: string, how: "created" | "patched", at = new Date()): Promise<void> {
  return withLock(async () => {
    const usage = await readUsage();
    const entry = entryFor(usage, name);
    const stamp = at.toISOString();
    if (how === "created") entry.createdAt = stamp;
    else {
      entry.patchedAt = stamp;
      entry.patchCount += 1;
    }
    delete entry.state;
    await writeUsage(usage);
  });
}

/**
 * Skills that took part in a turn. Only the agent's own are counted: the
 * others are not ours to age.
 */
export function noteSkillsUsed(names: string[], at = new Date()): Promise<string[]> {
  return withLock(async () => {
    if (names.length === 0) return [];
    const learned = new Set((await listOrchestratorSkills()).filter((skill) => skill.learned).map((skill) => skill.name));
    const counted = [...new Set(names)].filter((name) => learned.has(name));
    if (counted.length === 0) return [];
    const usage = await readUsage();
    const stamp = at.toISOString();
    for (const name of counted) {
      const entry = entryFor(usage, name);
      entry.useCount += 1;
      entry.lastUsedAt = stamp;
      delete entry.state;
    }
    await writeUsage(usage);
    return counted;
  });
}

export interface CuratorOutcome {
  ran: boolean;
  stale: string[];
  archived: string[];
}

function laterOf(...stamps: Array<string | undefined>): number {
  let latest = 0;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const time = Date.parse(stamp);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest;
}

async function moveToArchive(name: string, from: string, now: Date): Promise<string> {
  const archive = skillsArchiveDir();
  await fs.mkdir(archive, { recursive: true });
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  let target = path.join(archive, `${name}-${day}`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.lstat(target);
      target = path.join(archive, `${name}-${day}-${attempt}`);
    } catch {
      break;
    }
  }
  await fs.rename(from, target);
  return target;
}

/**
 * One housekeeping pass over the agent's own skills.
 *
 * `force` skips the once-a-day gate, for the tests and for a person who asks.
 */
export function runCurator(options: { now?: Date; force?: boolean } = {}): Promise<CuratorOutcome> {
  return withLock(async () => {
    const now = options.now ?? new Date();
    const limits = curatorLimits();
    const usage = await readUsage();
    const lastRun = laterOf(usage.curatorRanAt);
    if (!options.force && lastRun && now.getTime() - lastRun < limits.everyHours * 3_600_000) {
      return { ran: false, stale: [], archived: [] };
    }

    const outcome: CuratorOutcome = { ran: true, stale: [], archived: [] };
    const skills = (await listOrchestratorSkills()).filter((skill) => skill.learned);
    const day = 86_400_000;

    for (const skill of skills) {
      const entry = usage.skills[skill.name];
      let fileTime = 0;
      try {
        fileTime = (await fs.stat(path.join(skill.dir, "SKILL.md"))).mtimeMs;
      } catch {
        // Gone while we looked.
      }
      const lastActive = laterOf(entry?.lastUsedAt, entry?.patchedAt, entry?.createdAt, skill.learnedAt) || 0;
      // A skill nobody here has counted yet is as old as its file; one with no
      // date at all starts today rather than being judged on nothing.
      const reference = Math.max(lastActive, fileTime) || now.getTime();
      const idleDays = (now.getTime() - reference) / day;

      if (idleDays >= limits.archiveAfterDays) {
        try {
          await moveToArchive(skill.name, skill.dir, now);
          delete usage.skills[skill.name];
          outcome.archived.push(skill.name);
          await appendJournal([{
            at: now.toISOString(),
            source: "curator",
            what: "skill",
            action: "archived",
            text: `${skill.name}: unused for ${Math.floor(idleDays)} days`,
          }]);
        } catch (error) {
          console.warn(`Could not archive the learned skill ${skill.name}:`, error);
        }
      } else if (idleDays >= limits.staleAfterDays) {
        const current = entryFor(usage, skill.name);
        if (current.state !== "stale") {
          current.state = "stale";
          outcome.stale.push(skill.name);
        }
      } else if (entry?.state) {
        delete entry.state;
      }
    }

    usage.curatorRanAt = now.toISOString();
    await writeUsage(usage);
    return outcome;
  });
}

export async function learnedSkillsView(): Promise<{ skills: LearnedSkillView[]; archived: number }> {
  const [skills, usage] = await Promise.all([listOrchestratorSkills(), readUsage()]);
  let archived = 0;
  try {
    archived = (await fs.readdir(skillsArchiveDir(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  } catch {
    // Nothing archived.
  }
  return {
    skills: skills
      .filter((skill) => skill.learned)
      .map((skill) => {
        const entry = usage.skills[skill.name];
        return {
          name: skill.name,
          description: skill.description,
          state: entry?.state === "stale" ? "stale" : "active",
          useCount: entry?.useCount ?? 0,
          ...(entry?.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
        };
      }),
    archived,
  };
}
