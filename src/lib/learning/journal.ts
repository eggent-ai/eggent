import fs from "fs/promises";
import path from "path";
import { learningStateDir } from "@/lib/learning/paths";

/**
 * An append-only record of what was learned, when, and from where.
 *
 * Nobody reads it day to day. It is for the day somebody asks "why does it
 * think that?", and for finding which conversation taught the agent a wrong
 * thing. One line of JSON per change, trimmed to the last half megabyte so it
 * can never become a thing to clean up.
 */

const FILE_NAME = "journal.jsonl";
const MAX_BYTES = 512 * 1024;

export interface JournalEntry {
  at: string;
  /** Who wrote it: the background review, the person in Settings, or housekeeping. */
  source: "review" | "user" | "curator";
  what: "user" | "note" | "skill";
  action: string;
  text: string;
  previous?: string;
  chatId?: string;
}

function journalPath(): string {
  return path.join(learningStateDir(), FILE_NAME);
}

let writing: Promise<void> = Promise.resolve();

/** Never throws: a missing record must not undo the change it describes. */
export function appendJournal(entries: JournalEntry[]): Promise<void> {
  if (entries.length === 0) return writing;
  writing = writing
    .then(async () => {
      const file = journalPath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES) await fs.rename(file, `${file}.1`);
      } catch {
        // No journal yet.
      }
      await fs.appendFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
    })
    .catch((error) => {
      console.warn("Could not write the learning journal:", error);
    });
  return writing;
}

/** The most recent entries, newest last. For the tests and for debugging. */
export async function readJournal(limit = 200): Promise<JournalEntry[]> {
  try {
    const raw = await fs.readFile(journalPath(), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as JournalEntry);
  } catch {
    return [];
  }
}
