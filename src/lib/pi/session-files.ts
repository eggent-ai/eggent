import fs from "fs";
import path from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function getEggentPiSessionDir(): string {
  return path.join(process.cwd(), "data", "pi-sessions");
}

function safeSessionName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * The file the runtime keeps for one chat, when it has one: the newest of the
 * files named for it. The same choice is made when the chat is opened, so
 * anything that asks "what does the agent know of this chat" reads the file
 * the agent would.
 */
export function findChatSessionFile(chatId: string): string | null {
  const sessionDir = getEggentPiSessionDir();
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }
  const suffix = `_${safeSessionName(chatId)}.jsonl`;
  const existing = names.filter((file) => file.endsWith(suffix)).sort();
  const newest = existing[existing.length - 1];
  return newest ? path.join(sessionDir, newest) : null;
}

/**
 * The runtime's own record of one chat: the newest file kept for it, or a new
 * one. A chat's context lives here, not in the stored chat the screen shows.
 */
export function openChatSessionManager(chatId: string, cwd: string): SessionManager {
  const sessionDir = getEggentPiSessionDir();
  fs.mkdirSync(sessionDir, { recursive: true });
  const existing = findChatSessionFile(chatId);

  if (existing) {
    return SessionManager.open(existing, sessionDir, cwd);
  }

  return SessionManager.create(cwd, sessionDir, { id: safeSessionName(chatId) });
}
