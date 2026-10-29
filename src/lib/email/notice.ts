import { getActiveRun } from "@/lib/pi/active-runs";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { senderOf } from "@/lib/email/describe";
import { markReplyNoted, originChatOf, rememberedLetters, replyNoted } from "@/lib/email/store";
import type { EmailReplyNotice, EmailSummary } from "@/lib/email/types";

/**
 * A reply to one of the agent's letters, told in the chat the letter left from.
 *
 * The reply is not read to the model and starts nothing: one line goes under
 * the newest finished answer of that chat, with who wrote and the subject and
 * a link to the letter. The person decides what to do with it. A chat with a
 * turn running is left until the next look, so the turn's own writes cannot
 * cover the line.
 */

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const SUBJECT_MAX = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tells every reply not told yet. Returns how many were told. */
export async function noteEmailReplies(now = Date.now()): Promise<number> {
  const letters = await rememberedLetters();
  const byId = new Map(letters.map((letter) => [letter.id, letter]));
  let told = 0;
  for (const letter of [...letters].reverse()) {
    if (letter.direction !== "in" || !letter.answers) continue;
    if (now - Date.parse(letter.at) > RECENT_MS) continue;
    if (await replyNoted(letter.id)) continue;
    const answered = byId.get(letter.answers);
    const chatId = answered ? await originChatOf(answered) : await originChatOf({ id: letter.answers, requestId: null });
    if (!chatId) {
      await markReplyNoted(letter.id);
      continue;
    }
    if (getActiveRun(chatId)) continue;
    if (await attachReply(chatId, letter)) told += 1;
    await markReplyNoted(letter.id);
  }
  return told;
}

async function attachReply(chatId: string, letter: EmailSummary): Promise<boolean> {
  const chat = await getChat(chatId);
  if (!chat) return false;
  const target = [...chat.messages].reverse().find((message) => message.role === "assistant" && !message.inProgress);
  if (!target) return false;
  const notice: EmailReplyNotice = {
    letterId: letter.id,
    from: senderOf(letter),
    subject: clip(letter.subject || "", SUBJECT_MAX),
    at: letter.at,
  };
  if (target.emailReplies?.some((entry) => entry.letterId === letter.id)) return false;
  target.emailReplies = [...(target.emailReplies ?? []), notice];
  await saveChat(chat);
  return true;
}
