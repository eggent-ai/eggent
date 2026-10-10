import { getServerTranslator } from "@/i18n/server";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import { resolveTelegramDestination, sendTelegramText } from "@/lib/telegram/outbound";
import { sentenceKey } from "@/lib/learning/sentences";
import type { LearnedChange } from "@/lib/learning/types";

/**
 * Telling the person what was kept.
 *
 * The agent writes things down about someone, and the least it owes them is to
 * say so, in the place they are already looking: under the answer it was
 * written after, in the chat, and as a short message in Telegram. What is shown
 * is the note itself, not "memory updated" - a person can only object to a
 * thing they can read.
 */

const NOTE_CLIP = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

/** The changes as they will be shown: clipped, and each said once. */
export function presentable(changes: LearnedChange[]): LearnedChange[] {
  const seen = new Set<string>();
  const result: LearnedChange[] = [];
  for (const change of changes) {
    const key = `${change.kind}:${change.action}:${change.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...change, text: clip(change.text, NOTE_CLIP), ...(change.detail ? { detail: clip(change.detail, NOTE_CLIP) } : {}) });
  }
  return result;
}

/**
 * Attach the changes to the answer they came from.
 *
 * The answer is found by time, not by id: the turn's message is the first
 * assistant message written after the turn began, and by the time a review is
 * done the person may already have asked something else.
 */
export async function attachLearnedNotice(input: { chatId: string; since: string; changes: LearnedChange[] }): Promise<boolean> {
  const items = presentable(input.changes);
  if (items.length === 0) return false;
  const chat = await getChat(input.chatId);
  if (!chat) return false;
  const target = chat.messages.find(
    (message) => message.role === "assistant" && !message.inProgress && message.createdAt >= input.since
  );
  if (!target) return false;
  target.learned = { at: new Date().toISOString(), items: [...(target.learned?.items ?? []), ...items] };
  await saveChat(chat);
  return true;
}

export interface TelegramTarget {
  chatId: string | number;
  botToken?: string;
}

/**
 * The Telegram chat a turn was answered in, from the data the host hands a run
 * and keeps out of every prompt. Null for a turn that did not come from there.
 */
export function telegramTargetFrom(toolRuntimeData?: Record<string, unknown>): TelegramTarget | undefined {
  const raw = toolRuntimeData?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const chatId = record.chatId;
  if (typeof chatId !== "string" && typeof chatId !== "number") return undefined;
  const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
  return { chatId, ...(botToken ? { botToken } : {}) };
}

const TELEGRAM_MAX_LINES = 4;

/** One short message in the chat the turn was answered in. Never throws. */
export async function sendTelegramNotice(target: TelegramTarget, changes: LearnedChange[]): Promise<boolean> {
  try {
    const items = presentable(changes);
    if (items.length === 0) return false;
    const t = await getServerTranslator();
    const lines = items
      .slice(0, TELEGRAM_MAX_LINES)
      .map((change) => {
        const key = sentenceKey(change);
        return key ? `- ${t(key, { text: change.text })}` : null;
      })
      .filter((line): line is string => Boolean(line));
    if (lines.length === 0) return false;
    if (items.length > TELEGRAM_MAX_LINES) {
      lines.push(`- ${t("learning.notice.more", { count: items.length - TELEGRAM_MAX_LINES })}`);
    }
    const destination = await resolveTelegramDestination({ chatId: target.chatId, botToken: target.botToken });
    if (!destination) return false;
    const result = await sendTelegramText(destination, [t("learning.telegram.header"), ...lines].join("\n"));
    return result.success;
  } catch (error) {
    console.warn("Could not tell the person what was saved:", error);
    return false;
  }
}
