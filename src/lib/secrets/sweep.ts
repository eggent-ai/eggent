import fs from "node:fs/promises";
import path from "node:path";
import type { Chat } from "@/lib/types";
import { withoutInlineImages } from "@/lib/storage/chat-media";
import { withoutSecrets } from "@/lib/secrets/mask";

/**
 * Masking the credentials already sitting in stored chats, once.
 *
 * New writes are masked as they happen. Chats from before that - a bot token
 * pasted in March, a key the agent printed in May - are rewritten here, once
 * per shape-list version, at boot: a file is touched only if something in it
 * was masked, only chat records (never the runtime's own session files, which
 * are the model's context), and only if nobody saved it in the meantime.
 *
 * A chat that was busy is not forgotten: the marker lists it, and the next run
 * looks at those and nothing else. A file that cannot be read is counted and
 * left, since asking again would not change its answer.
 */

/** Raise when the shapes grow, so the sweep runs again over what the new ones catch. */
export const SWEEP_VERSION = 2;

const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const MARKER = path.join(DATA_DIR, "secrets-sweep.json");

export interface SweepResult {
  scanned: number;
  masked: number;
  /** Changed, or written to, while it was being looked at: left for its own next save, and listed in `retry`. */
  skipped: number;
  /** Could not be read as a chat. */
  failed: number;
  /** File names to look at again. */
  retry: string[];
}

export interface SweepOptions {
  force?: boolean;
  /**
   * A chat written to more recently than this is left alone: somebody is using
   * it, and a rewrite now could land over their next save. Zero looks at all.
   */
  minAgeMs?: number;
}

async function readRetryList(): Promise<string[] | null> {
  try {
    const marker = JSON.parse(await fs.readFile(MARKER, "utf-8")) as { version?: number; retry?: unknown };
    if (marker.version !== SWEEP_VERSION) return null;
    return Array.isArray(marker.retry) ? marker.retry.filter((name): name is string => typeof name === "string") : [];
  } catch {
    // No marker: the sweep has not run.
    return null;
  }
}

export async function sweepStoredChats(options: SweepOptions = {}): Promise<SweepResult | null> {
  const retry = options.force ? null : await readRetryList();
  if (retry && retry.length === 0) return null;
  // Only what an earlier run left: a name read from a marker is never trusted as a path.
  const files = retry ? retry.filter((name) => name === path.basename(name) && name.endsWith(".json")) : await listChats();

  const minAgeMs = options.minAgeMs ?? 0;
  const result: SweepResult = { scanned: 0, masked: 0, skipped: 0, failed: 0, retry: [] };
  for (const file of files) {
    const target = path.join(CHATS_DIR, file);
    try {
      const before = await fs.stat(target);
      const chat = JSON.parse(await fs.readFile(target, "utf-8")) as Chat;
      result.scanned += 1;
      const masked = withoutSecrets(chat);
      if (masked === chat) continue;
      // Used a moment ago, or saved while it was being read: leave it, its next save masks it.
      const busy = async (): Promise<boolean> => {
        const now = await fs.stat(target);
        return now.mtimeMs !== before.mtimeMs || now.size !== before.size;
      };
      if (Date.now() - before.mtimeMs < minAgeMs || (await busy())) {
        result.skipped += 1;
        result.retry.push(file);
        continue;
      }
      const temporary = `${target}.sweep-${process.pid}`;
      try {
        await fs.writeFile(temporary, JSON.stringify(withoutInlineImages(masked), null, 2), "utf-8");
        // The write took a moment too: look once more before putting it in place.
        if (await busy()) {
          result.skipped += 1;
          result.retry.push(file);
          continue;
        }
        await fs.rename(temporary, target);
        result.masked += 1;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    } catch {
      result.failed += 1;
    }
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(MARKER, `${JSON.stringify({ version: SWEEP_VERSION, at: new Date().toISOString(), ...result }, null, 2)}\n`, "utf-8");
  return result;
}

async function listChats(): Promise<string[]> {
  try {
    return (await fs.readdir(CHATS_DIR)).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}
