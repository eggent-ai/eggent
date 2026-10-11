import fs from "fs/promises";
import path from "path";
import type { Chat, ChatContextMode, ChatListItem } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { withoutInlineImages } from "@/lib/storage/chat-media";
import { withoutSecrets } from "@/lib/secrets/mask";

const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function getAllChats(): Promise<ChatListItem[]> {
  await ensureDir(CHATS_DIR);
  const files = await fs.readdir(CHATS_DIR);
  const chats: ChatListItem[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(CHATS_DIR, file), "utf-8");
      const chat: Chat = JSON.parse(content);
      chats.push({
        id: chat.id,
        title: chat.title,
        projectId: chat.projectId,
        contextMode: chat.contextMode,
        ...(chat.scheduledRun?.jobName ? { scheduledJob: chat.scheduledRun.jobName } : {}),
        ...(chat.visit ? { visitFrom: chat.visit.fromTitle || chat.visit.fromChatId } : {}),
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages.length,
      });
    } catch {
      // skip corrupted files
    }
  }

  return chats.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

// Files already looked through for credentials and found clean, by chat and by
// what the file was when it was looked at. The chat page asks for the open
// conversation every thirty seconds and almost always nothing has changed, so
// a conversation that was clean a moment ago is not walked again.
const KNOWN_CLEAN_LIMIT = 500;
const knownClean = new Map<string, string>();

export async function getChat(chatId: string): Promise<Chat | null> {
  await ensureDir(CHATS_DIR);
  const filePath = path.join(CHATS_DIR, `${chatId}.json`);
  try {
    const stat = await fs.stat(filePath);
    const content = await fs.readFile(filePath, "utf-8");
    // A chat saved before pictures were dropped on write still carries them,
    // and this is what the chat page downloads. One saved before credentials
    // were masked on write may carry those: masked here too, so what a screen or
    // the chat browser shows never has one in it, whatever the file still holds.
    const stripped = withoutInlineImages(JSON.parse(content) as Chat);
    const identity = `${stat.mtimeMs}:${stat.size}`;
    if (knownClean.get(chatId) === identity) return stripped;
    const masked = withoutSecrets(stripped);
    if (masked === stripped) {
      if (knownClean.size >= KNOWN_CLEAN_LIMIT) knownClean.clear();
      knownClean.set(chatId, identity);
    }
    return masked;
  } catch {
    return null;
  }
}

export async function saveChat(chat: Chat): Promise<void> {
  await ensureDir(CHATS_DIR);
  const filePath = path.join(CHATS_DIR, `${chat.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(withoutSecrets(withoutInlineImages(chat)), null, 2), "utf-8");
  publishUiSyncEvent({
    topic: "chat",
    chatId: chat.id,
    projectId: chat.projectId ?? null,
    reason: "chat_saved",
  });
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const existing = await getChat(chatId);
  const filePath = path.join(CHATS_DIR, `${chatId}.json`);
  try {
    await fs.unlink(filePath);
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: existing?.projectId ?? null,
      reason: "chat_deleted",
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete all chats that belong to the given project. Returns number of deleted chats. */
export async function deleteChatsByProjectId(projectId: string): Promise<number> {
  await ensureDir(CHATS_DIR);
  const files = await fs.readdir(CHATS_DIR);
  let deleted = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(CHATS_DIR, file), "utf-8");
      const chat: Chat = JSON.parse(content);
      if (chat.projectId === projectId) {
        await fs.unlink(path.join(CHATS_DIR, file));
        deleted++;
      }
    } catch {
      // skip corrupted files
    }
  }
  if (deleted > 0) {
    publishUiSyncEvent({
      topic: "chat",
      projectId,
      reason: "project_chats_deleted",
    });
  }
  return deleted;
}

export async function createChat(
  id: string,
  title: string,
  projectId?: string,
  contextMode?: ChatContextMode
): Promise<Chat> {
  const now = new Date().toISOString();
  const chat: Chat = {
    id,
    title,
    projectId,
    // Stored only when it is not the default, so nothing changes on disk for
    // the chats that every other surface creates.
    ...(contextMode && contextMode !== "full" ? { contextMode } : {}),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveChat(chat);
  return chat;
}
