import crypto from "node:crypto";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";
import type { ChatMessage } from "@/lib/types";
import { cleanTranscript } from "@/lib/voice/tools";

const MAX_SUMMARY_CHARS = 4000;
const MAX_DELEGATED = 50;

export interface VoiceCallInput {
  chatId: string;
  projectId?: string;
  seconds: unknown;
  transcript: unknown;
  summary: unknown;
  delegated: unknown;
  title: string;
}

/**
 * Puts a finished call into its chat: one message carrying the call's length,
 * what was said and, as its text, the short summary the voice model wrote at
 * the end. A call held in a chat nobody had written in yet makes the chat.
 * Returns the message, or null when the call said nothing worth keeping.
 */
export async function recordVoiceCall(input: VoiceCallInput): Promise<ChatMessage | null> {
  const transcript = cleanTranscript(input.transcript);
  const seconds = Math.max(0, Math.min(24 * 3600, Math.round(Number(input.seconds) || 0)));
  const summary = typeof input.summary === "string" ? input.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "";
  const delegated = Array.isArray(input.delegated)
    ? input.delegated.filter((task): task is string => typeof task === "string" && task.trim().length > 0).map((task) => task.trim().slice(0, 2000)).slice(0, MAX_DELEGATED)
    : [];
  if (transcript.length === 0 && !summary) return null;

  const chat = (await getChat(input.chatId)) ?? (await createChat(input.chatId, input.title, input.projectId));
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: summary,
    createdAt: new Date().toISOString(),
    voiceCall: { seconds, transcript, ...(delegated.length ? { delegated } : {}) },
  };
  chat.messages.push(message);
  chat.updatedAt = message.createdAt;
  await saveChat(chat);
  return message;
}
