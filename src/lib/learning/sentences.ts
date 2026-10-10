import type { MessageKey } from "@/i18n/messages";
import type { LearnedChange } from "@/lib/learning/types";

/**
 * The sentence that says what was kept.
 *
 * Keys are written out rather than assembled: the message dictionary is typed,
 * and a key built from two variables is a key nothing checks. Client-safe, so
 * the chat and the Telegram message say the same thing in the same words.
 */
const SENTENCES: Record<string, MessageKey> = {
  "user:added": "learning.notice.user.added",
  "user:updated": "learning.notice.user.updated",
  "user:removed": "learning.notice.user.removed",
  "note:added": "learning.notice.note.added",
  "note:updated": "learning.notice.note.updated",
  "note:removed": "learning.notice.note.removed",
  "skill:created": "learning.notice.skill.created",
  "skill:patched": "learning.notice.skill.patched",
};

export function sentenceKey(change: Pick<LearnedChange, "kind" | "action">): MessageKey | null {
  return SENTENCES[`${change.kind}:${change.action}`] ?? null;
}
