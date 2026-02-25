import fs from "fs/promises";
import path from "path";
import { Chat, ChatListItem } from "@/lib/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

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

export async function getChat(chatId: string): Promise<Chat | null> {
  await ensureDir(CHATS_DIR);
  const filePath = path.join(CHATS_DIR, `${chatId}.json`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveChat(chat: Chat): Promise<void> {
  await ensureDir(CHATS_DIR);
  const filePath = path.join(CHATS_DIR, `${chat.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(chat, null, 2), "utf-8");
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
  projectId?: string
): Promise<Chat> {
  const now = new Date().toISOString();
  const chat: Chat = {
    id,
    title,
    projectId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveChat(chat);
  return chat;
}
