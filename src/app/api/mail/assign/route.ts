import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { fetchMailMessage } from "@/lib/mail/client";
import { mailFailure, mailGuard, NO_STORE } from "@/lib/mail/route-helpers";
import { lacksCopies, syncMailAttachments, withLocalCopies } from "@/lib/mail/sync";
import type { MailReplyInfo } from "@/lib/mail/types";
import { createChat, saveChat } from "@/lib/storage/chat-store";

const QUOTE_MAX_CHARS = 6000;

function shortened(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * "Hand it to the agent": a new chat, in the orchestrator, that answers one
 * message. The chat remembers which message (MailReplyInfo), so the agent is
 * shown it as material and every answer in the chat can be sent back with a
 * button. Nothing is sent from here.
 */
export async function POST(req: NextRequest) {
  const refused = await mailGuard(req, { write: true });
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown };
  const messageId = Number(body.messageId);
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return Response.json({ error: "Which message?", code: "noMessage" }, { status: 400, headers: NO_STORE });
  }
  try {
    const { message, contact } = await fetchMailMessage(messageId);
    let [withCopies] = await withLocalCopies([message]);
    if (lacksCopies([withCopies])) {
      await Promise.race([syncMailAttachments().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 4_000))]);
      [withCopies] = await withLocalCopies([message]);
    }
    const t = await getServerTranslator();
    const info: MailReplyInfo = {
      contactId: contact.id,
      contactName: contact.name,
      messageId: message.id,
      quote: message.text.length > QUOTE_MAX_CHARS ? `${message.text.slice(0, QUOTE_MAX_CHARS - 1)}…` : message.text,
      at: message.createdAt,
      ...(withCopies.attachments.some((file) => file.localPath)
        ? { files: withCopies.attachments.flatMap((file) => (file.localPath ? [file.localPath] : [])) }
        : {}),
    };
    const chat = await createChat(
      crypto.randomUUID(),
      t("mail.assign.chatTitle", { name: contact.name, quote: shortened(message.text || withCopies.attachments.map((file) => file.name).join(", "), 40) })
    );
    await saveChat({ ...chat, mailReply: info });
    return Response.json({ chatId: chat.id }, { headers: NO_STORE });
  } catch (error) {
    return mailFailure(error);
  }
}
