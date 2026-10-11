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
 */

/** Raise when the shapes grow, so the sweep runs again over what the new ones catch. */
export const SWEEP_VERSION = 1;

const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const MARKER = path.join(DATA_DIR, "secrets-sweep.json");

export interface SweepResult {
  scanned: number;
  masked: number;
  skipped: number;
}

export async function sweepStoredChats(options: { force?: boolean } = {}): Promise<SweepResult | null> {
  if (!options.force) {
    try {
      const marker = JSON.parse(await fs.readFile(MARKER, "utf-8")) as { version?: number };
      if (marker.version === SWEEP_VERSION) return null;
    } catch {
      // No marker: the sweep has not run.
    }
  }

  let files: string[];
  try {
    files = (await fs.readdir(CHATS_DIR)).filter((file) => file.endsWith(".json"));
  } catch {
    return { scanned: 0, masked: 0, skipped: 0 };
  }

  const result: SweepResult = { scanned: 0, masked: 0, skipped: 0 };
  for (const file of files) {
    const target = path.join(CHATS_DIR, file);
    try {
      const before = await fs.stat(target);
      const chat = JSON.parse(await fs.readFile(target, "utf-8")) as Chat;
      result.scanned += 1;
      const masked = withoutSecrets(chat);
      if (masked === chat) continue;
      // Somebody saved this chat while it was being read: leave it, the next save masks it.
      const now = await fs.stat(target);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
        result.skipped += 1;
        continue;
      }
      const temporary = `${target}.sweep-${process.pid}`;
      await fs.writeFile(temporary, JSON.stringify(withoutInlineImages(masked), null, 2), "utf-8");
      await fs.rename(temporary, target);
      result.masked += 1;
    } catch {
      result.skipped += 1;
    }
  }

  // A chat skipped for a concurrent save is masked by that save; the rest is done.
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(MARKER, `${JSON.stringify({ version: SWEEP_VERSION, at: new Date().toISOString(), ...result }, null, 2)}\n`, "utf-8");
  return result;
}
