import type { Chat, ChatFile } from "@/lib/types";
import { getChatFiles } from "@/lib/storage/chat-files-store";

const MAX_NAMED = 10;

/**
 * The chat's files that arrived after the conversation's last message: what the
 * person attached to the message being sent now.
 *
 * The session lists the chat's files when it is built, and a session can outlive
 * many messages (one kept for the chat's schedules lives for days), so a picture
 * sent with "look at the attached image" was not on the list it read. The agent
 * said three times that it saw no image and went looking through the project.
 */
export function freshAttachments(files: ChatFile[], chat: Pick<Chat, "messages"> | null): ChatFile[] {
  const last = chat?.messages?.[chat.messages.length - 1]?.createdAt;
  const since = last ? Date.parse(last) - 2000 : Number.NEGATIVE_INFINITY;
  return files
    .filter((file) => {
      const at = Date.parse(file.uploadedAt);
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt))
    .slice(-MAX_NAMED);
}

/** What the agent reads about them, for this turn only. */
export function freshAttachmentsNote(files: ChatFile[]): string | null {
  if (files.length === 0) return null;
  return [
    "Attached by the person to this message (read them by the absolute path; open pictures with the read tool):",
    ...files.map((file) => `- ${file.name} (${file.type}): ${file.path}`),
  ].join("\n");
}

export async function describeFreshAttachments(chatId: string, chat: Pick<Chat, "messages"> | null): Promise<string | null> {
  const files = await getChatFiles(chatId).catch(() => [] as ChatFile[]);
  return freshAttachmentsNote(freshAttachments(files, chat));
}
