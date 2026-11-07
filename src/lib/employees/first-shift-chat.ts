import { getChat } from "@/lib/storage/chat-store";

/** Whether this chat is the first job someone typed in their own words: it opens with the skill's command. */
export async function isFirstShiftChat(chatId: string): Promise<boolean> {
  const chat = await getChat(chatId).catch(() => null);
  const first = chat?.messages.find((message) => message.role === "user");
  return typeof first?.content === "string" && /^\/skill:first-shift(\s|$)/.test(first.content);
}
