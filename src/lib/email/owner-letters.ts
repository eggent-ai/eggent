import { getServerTranslator } from "@/i18n/server";
import { downloadEmailAttachment, fetchEmailMessage, sendEmailThroughService } from "@/lib/email/client";
import { senderOf, trustOf } from "@/lib/email/describe";
import {
  answeringOwnerSince,
  lettersFromChat,
  markOwnerLetterAnswered,
  originChatOf,
  ownerLetterAnswered,
  rememberLetterOrigin,
  rememberedLetters,
  saveLetterFile,
  takeLimitNotice,
} from "@/lib/email/store";
import type { EmailLetterInfo, EmailSummary } from "@/lib/email/types";
import { getActiveRun } from "@/lib/pi/active-runs";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";

/**
 * A letter the person wrote to their own agent gets an answer, by email.
 *
 * The service says a letter is from the person (`fromOwner`) only when it came
 * from their confirmed address and their mail provider signed it, so its words
 * are theirs and the agent may act on them as on a message typed here. A reply
 * to one of the agent's letters is answered in the chat that letter left from;
 * anything else in a chat of its own.
 *
 * Writing to the agent has to work every time or people learn it does not, so
 * every letter gets a letter back: the agent's own reply; its last words in the
 * chat when it did not send one; or, when it could not answer at all, why - the
 * deployment's own sentence when the model was refused (a spent balance), the
 * failure otherwise, and once a day that the day's answers ran out.
 *
 * Bounded on purpose: letters that came after this workspace began answering
 * and within the last two days, each once (marked before the turn, so a
 * failure is not retried into a loop), a few a pass and a dozen a day - an
 * auto-reply on the person's side must not keep the agent writing back.
 */

const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_PASS = 3;
export const OWNER_LETTERS_PER_DAY = 12;
const QUOTE_MAX_CHARS = 6000;
const TITLE_MAX = 60;
const REASON_MAX = 300;

/** How a turn that answered a letter ended, as far as the letter needs to know. */
export interface OwnerLetterTurn {
  finalText?: string;
  refused?: boolean;
  refusalText?: string;
}

export type OwnerLetterRunner = (chatId: string, message: string, projectId: string | undefined) => Promise<OwnerLetterTurn>;

function ownLines(text: string): string {
  // The quoted history of earlier letters stays out of what the person "says"; the context names it as history.
  const kept = text.split("\n").filter((line) => !line.trimStart().startsWith(">"));
  const body = kept.join("\n").trim();
  return body.length > QUOTE_MAX_CHARS ? `${body.slice(0, QUOTE_MAX_CHARS - 1)}…` : body;
}

function shortened(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function replySubject(subject: string): string {
  const clean = (subject || "").trim();
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`.trim();
}

export function isOwnerLetterToAnswer(letter: EmailSummary, since: number, now: number): boolean {
  if (letter.direction !== "in" || !letter.fromOwner || letter.folder === "bounce" || letter.suspicious) return false;
  const at = Date.parse(letter.at);
  return Number.isFinite(at) && at >= since && now - at <= RECENT_MS;
}

/** A letter back to the person, answering theirs, remembered as having left from the chat. */
async function writeBack(letter: Pick<EmailSummary, "id" | "subject">, text: string, chatId: string | null): Promise<void> {
  const answer = await sendEmailThroughService({ text, subject: replySubject(letter.subject), attachments: [], replyTo: letter.id });
  if (answer.status === "sent" && chatId) await rememberLetterOrigin({ chatId, ids: answer.ids });
}

/** Starts an answer for each of the person's letters not answered yet. Returns how many were taken. */
export async function answerOwnerLetters(now = Date.now(), run: OwnerLetterRunner = defaultRun): Promise<number> {
  const since = await answeringOwnerSince(now);
  const letters = (await rememberedLetters()).filter((letter) => isOwnerLetterToAnswer(letter, since, now));
  let answeredToday = 0;
  for (const letter of letters) {
    if (now - Date.parse(letter.at) <= DAY_MS && (await ownerLetterAnswered(letter.id))) answeredToday += 1;
  }
  let taken = 0;
  for (const letter of [...letters].sort((a, b) => a.id - b.id)) {
    if (taken >= PER_PASS) break;
    if (await ownerLetterAnswered(letter.id)) continue;
    if (answeredToday >= OWNER_LETTERS_PER_DAY) {
      // Past the day's answers: this letter is not answered, and the person is told so once a day.
      if (!(await markOwnerLetterAnswered(letter.id))) continue;
      taken += 1;
      if (await takeLimitNotice(now)) {
        const t = await getServerTranslator(null);
        await writeBack(letter, t("email.owner.limit", { count: String(OWNER_LETTERS_PER_DAY) }), null).catch((error) =>
          console.warn(`[email] the day's limit not told: ${error instanceof Error ? error.message : error}`)
        );
      }
      continue;
    }
    const origin = letter.answers ? await originChatOf({ id: letter.answers, requestId: null }) : null;
    const originChat = origin ? await getChat(origin) : null;
    // A turn already working in that chat finishes first; the letter waits for the next look.
    if (originChat && getActiveRun(originChat.id)) continue;
    if (!(await markOwnerLetterAnswered(letter.id))) continue;
    taken += 1;
    answeredToday += 1;
    try {
      await startAnswer(letter, originChat, run);
    } catch (error) {
      console.warn(`[email] letter ${letter.id} not answered: ${error instanceof Error ? error.message : error}`);
    }
  }
  return taken;
}

async function startAnswer(
  letter: EmailSummary,
  originChat: Awaited<ReturnType<typeof getChat>>,
  run: OwnerLetterRunner
): Promise<void> {
  const full = await fetchEmailMessage(letter.id);
  const files: string[] = [];
  for (const attachment of full.attachments) {
    try {
      const file = await downloadEmailAttachment(full.id, attachment.n);
      files.push(await saveLetterFile(full.id, attachment.n, attachment.name, file.data));
    } catch (error) {
      console.warn(`[email] file ${attachment.n} of letter ${full.id} not saved: ${error instanceof Error ? error.message : error}`);
    }
  }
  const said = ownLines(full.text) || shortened(full.subject || "", 200);
  const info: EmailLetterInfo = {
    letterId: full.id,
    from: senderOf(full),
    sender: trustOf(full),
    subject: full.subject,
    at: full.at,
    quote: said,
    ...(files.length ? { files } : {}),
    fromOwner: true,
  };
  let chatId: string;
  let projectId: string | undefined;
  if (originChat) {
    await saveChat({ ...originChat, emailLetter: info });
    chatId = originChat.id;
    projectId = originChat.projectId || undefined;
  } else {
    const chat = await createChat(crypto.randomUUID(), `✉ ${shortened(full.subject || said || "", TITLE_MAX)}`);
    await saveChat({ ...chat, emailLetter: info });
    chatId = chat.id;
  }
  console.log(`[email] answering the person's letter ${full.id} in chat ${chatId.slice(0, 8)}`);
  const sentBefore = new Set(await lettersFromChat(chatId));
  // The turn takes as long as it takes; the sync goes on and the answer is checked when it ends.
  void (async () => {
    let turn: OwnerLetterTurn = {};
    let failure: unknown = null;
    try {
      turn = await run(chatId, said || full.subject || "(an empty letter)", projectId);
    } catch (error) {
      failure = error;
    }
    await closeLetterTurn(chatId, full.id);
    const sent = (await lettersFromChat(chatId)).some((id) => !sentBefore.has(id));
    if (sent) return;
    const t = await getServerTranslator(null);
    const text = turn.refused
      ? t("email.owner.refused", { reason: shortened(turn.refusalText || "", REASON_MAX) })
      : failure
        ? t("email.owner.failed", { reason: shortened(failure instanceof Error ? failure.message : String(failure), REASON_MAX) })
        : (turn.finalText || "").trim();
    if (!text) return;
    await writeBack(full, text, chatId);
    console.log(`[email] letter ${full.id}: ${turn.refused ? "the refusal" : failure ? "the failure" : "the chat's answer"} sent back by mail`);
  })().catch((error) => console.warn(`[email] the answer to letter ${full.id} did not go: ${error instanceof Error ? error.message : error}`));
}

/** After its turn the letter is history: the next message in the chat is the person typing there. */
async function closeLetterTurn(chatId: string, letterId: number): Promise<void> {
  const chat = await getChat(chatId).catch(() => null);
  if (!chat?.emailLetter || chat.emailLetter.letterId !== letterId) return;
  await saveChat({ ...chat, emailLetter: { ...chat.emailLetter, answered: true } }).catch(() => undefined);
}

async function defaultRun(chatId: string, message: string, projectId: string | undefined): Promise<OwnerLetterTurn> {
  // Loaded when needed: the runner pulls in the whole agent, and this file is read at every sync.
  const { runPiAgentText } = await import("@/lib/pi/chat-runner");
  const outcome: NonNullable<Parameters<typeof runPiAgentText>[0]["outcome"]> = {};
  const reply = await runPiAgentText({ chatId, userMessage: message, ...(projectId ? { projectId } : {}), outcome });
  return { finalText: outcome.finalText || reply, refused: outcome.refused, refusalText: outcome.refusalText };
}
