import fs from "fs";
import path from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function getEggentPiSessionDir(): string {
  return path.join(process.cwd(), "data", "pi-sessions");
}

/**
 * The runtime's own record of one chat: the newest file kept for it, or a new
 * one. A chat's context lives here, not in the stored chat the screen shows.
 */
export function openChatSessionManager(chatId: string, cwd: string): SessionManager {
  const sessionDir = getEggentPiSessionDir();
  fs.mkdirSync(sessionDir, { recursive: true });
  const safeChatId = chatId.replace(/[^A-Za-z0-9._-]/g, "-");
  const existingSessions = fs
    .readdirSync(sessionDir)
    .filter((file) => file.endsWith(`_${safeChatId}.jsonl`))
    .sort();
  const existing = existingSessions[existingSessions.length - 1];

  if (existing) {
    return SessionManager.open(path.join(sessionDir, existing), sessionDir, cwd);
  }

  return SessionManager.create(cwd, sessionDir, { id: safeChatId });
}
