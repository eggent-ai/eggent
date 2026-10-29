import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { downloadEmailAttachment, fetchEmailMessage } from "@/lib/email/client";
import { senderOf, trustOf } from "@/lib/email/describe";
import { emailFailure, emailGuard, NO_STORE } from "@/lib/email/route-helpers";
import { saveLetterFile } from "@/lib/email/store";
import type { EmailLetterInfo } from "@/lib/email/types";
import { createChat, saveChat } from "@/lib/storage/chat-store";

const QUOTE_MAX_CHARS = 6000;

function shortened(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * "Hand it to the agent": a new chat, in the orchestrator, about one letter
 * that came in. The chat remembers the letter (EmailLetterInfo), so the agent
 * is shown it as material from outside; its files are saved here first, where
 * the agent can read them. Nothing is sent from here.
 */
export async function POST(req: NextRequest) {
  const refused = await emailGuard(req, { write: true });
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { letterId?: unknown };
  const letterId = Number(body.letterId);
  if (!Number.isInteger(letterId) || letterId <= 0) {
    return Response.json({ error: "Which letter?", code: "noMessage" }, { status: 400, headers: NO_STORE });
  }
  try {
    const letter = await fetchEmailMessage(letterId);
    if (letter.direction !== "in") {
      return Response.json({ error: "Only a letter that came in can be handed over.", code: "notIncoming" }, { status: 400, headers: NO_STORE });
    }
    const files: string[] = [];
    for (const attachment of letter.attachments) {
      try {
        const file = await downloadEmailAttachment(letter.id, attachment.n);
        files.push(await saveLetterFile(letter.id, attachment.n, attachment.name, file.data));
      } catch (error) {
        console.warn(`[email] file ${attachment.n} of letter ${letter.id} not saved: ${error instanceof Error ? error.message : error}`);
      }
    }
    const info: EmailLetterInfo = {
      letterId: letter.id,
      from: senderOf(letter),
      sender: trustOf(letter),
      subject: letter.subject,
      at: letter.at,
      quote: letter.text.length > QUOTE_MAX_CHARS ? `${letter.text.slice(0, QUOTE_MAX_CHARS - 1)}…` : letter.text,
      ...(files.length ? { files } : {}),
    };
    const t = await getServerTranslator();
    const chat = await createChat(
      crypto.randomUUID(),
      t("email.assign.chatTitle", { from: letter.from.name || letter.from.address || "?", subject: shortened(letter.subject || letter.preview || "", 40) })
    );
    await saveChat({ ...chat, emailLetter: info });
    return Response.json({ chatId: chat.id }, { headers: NO_STORE });
  } catch (error) {
    return emailFailure(error);
  }
}
