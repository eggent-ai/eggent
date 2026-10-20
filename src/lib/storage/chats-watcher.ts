import fs from "node:fs";
import path from "node:path";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getChat, wroteChatHereLately } from "@/lib/storage/chat-store";

/**
 * Tell the screen when a chat's file changes without this process having done it.
 *
 * Chats are files, and files arrive from places other than this server: the
 * sync with a paired workspace or computer writes them, in the middle of
 * nothing, while the person watches a chat that has just been answered
 * somewhere else. The screen learns about changes through events this process
 * publishes when it saves, so a file that simply appears is invisible to it
 * until the next poll - half a minute away, which feels like the answer got
 * lost on the way.
 *
 * Writes this process made itself were announced when they happened and are
 * skipped here. Writers replace a file rather than edit it, so one change is
 * several events; they are folded into one per chat.
 */

const WATCHER_KEY = "__EGGENT_CHATS_WATCHER__";
const SETTLE_MS = 300;

export function startChatsWatcher(): void {
  const holder = globalThis as typeof globalThis & { [WATCHER_KEY]?: fs.FSWatcher };
  if (holder[WATCHER_KEY]) return;

  const dir = path.join(process.cwd(), "data", "chats");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const announce = async (chatId: string) => {
    if (wroteChatHereLately(chatId)) return;
    const chat = await getChat(chatId).catch(() => null);
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: chat?.projectId ?? null,
      reason: chat ? "chat_synced" : "chat_deleted",
    });
  };

  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      // The temporary names writers use on their way to the real one are not chats.
      if (!name.endsWith(".json") || name.startsWith(".")) return;
      const chatId = name.slice(0, -".json".length);
      const pending = timers.get(chatId);
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => {
        timers.delete(chatId);
        void announce(chatId);
      }, SETTLE_MS);
      timer.unref?.();
      timers.set(chatId, timer);
    });
    watcher.on("error", (error) => {
      console.warn("[chats] watcher stopped:", error instanceof Error ? error.message : error);
      delete holder[WATCHER_KEY];
    });
    holder[WATCHER_KEY] = watcher;
  } catch (error) {
    console.warn("[chats] could not watch the chats folder:", error instanceof Error ? error.message : error);
  }
}
