import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";
import { recordTelegramMessages, RELAY_BOT_KEY } from "@/lib/telegram/conversation";
import { getServerTranslator } from "@/i18n/server";

/**
 * A bot that runs outside this workspace says which messages it sent and from
 * which chat.
 *
 * The deployment's shared bot sends the answers itself, so the message ids
 * Telegram gives them are known only there. Without this, replying to one of
 * those answers could not find the chat it came from; with it, a reply to any
 * answer continues that answer's chat, as it does for this workspace's own bot.
 */

interface SentMessagesBody {
  telegramChatId?: unknown;
  messageIds?: unknown;
  chatId?: unknown;
}

function parseBearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function safeTokenMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const storedToken = await getExternalApiToken();
  const expectedToken = storedToken || process.env.EXTERNAL_API_TOKEN?.trim();
  if (!expectedToken) {
    return Response.json({ error: t("api.error.externalTokenMissing") }, { status: 503 });
  }
  const providedToken = parseBearerToken(req);
  if (!providedToken || !safeTokenMatch(providedToken, expectedToken)) {
    return Response.json(
      { error: t("api.error.unauthorized") },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="external-telegram-sent"' } }
    );
  }

  const body = (await req.json().catch(() => null)) as SentMessagesBody | null;
  const telegramChatId = body?.telegramChatId;
  const chatId = typeof body?.chatId === "string" ? body.chatId.trim() : "";
  const messageIds = Array.isArray(body?.messageIds)
    ? body.messageIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)
    : [];
  if ((typeof telegramChatId !== "string" && typeof telegramChatId !== "number") || !chatId || !messageIds.length) {
    return Response.json({ error: "telegramChatId, chatId and messageIds are required." }, { status: 400 });
  }

  await recordTelegramMessages({ botKey: RELAY_BOT_KEY, telegramChatId, messageIds, chatId });
  return Response.json({ success: true, recorded: messageIds.length });
}
