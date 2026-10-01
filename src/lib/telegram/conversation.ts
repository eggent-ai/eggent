import fs from "fs/promises";
import path from "path";
import { getChat } from "@/lib/storage/chat-store";
import {
  getOrCreateExternalSession,
  saveExternalSession,
  setSessionChatId,
  type ExternalSession,
} from "@/lib/storage/external-session-store";
import {
  createDefaultTelegramSessionId,
  getTelegramChatSessionId,
} from "@/lib/storage/telegram-session-store";
import { projectKeyboard, withChatFooter } from "@/lib/telegram/format";
import { getProject } from "@/lib/storage/project-store";
import {
  rememberedTelegramSessionId,
  resolveTelegramDestination,
  sendTelegramMarkdownText,
  type TelegramDestination,
  type TelegramSendResult,
} from "@/lib/telegram/outbound";

/**
 * Which chat a Telegram conversation is talking to.
 *
 * Telegram is one thread; the workspace keeps many chats. Everything written
 * into that thread used to land in whichever chat the session last spoke in,
 * so a morning report arrived from one chat and the answer to it went into
 * another - the person had replied to the report, and the agent reading the
 * reply had never seen it. Two rules decide it now:
 *
 *  - A reply goes to the chat the replied-to message came from. Every message
 *    sent to Telegram is recorded with its chat, so this holds for an answer
 *    from last week as much as for this morning's report.
 *  - Anything else goes to the chat that wrote last. A delivery from another
 *    chat - a scheduled run's report, a file sent from the web - moves the
 *    conversation there, so the next message continues what was just read.
 */

const ROUTES_FILENAME = "telegram-message-routes.json";
// Enough for weeks of a busy chat. A reply to anything older than this simply
// goes where the conversation is.
const MAX_ROUTES = 3000;

/** The deployment's shared bot, which has no token in this workspace. */
export const RELAY_BOT_KEY = "relay";

interface RouteRecord {
  chatId: string;
  at: string;
}

interface RoutesFile {
  routes: Record<string, RouteRecord>;
}

function routesPath(): string {
  return path.join(process.cwd(), "data", ROUTES_FILENAME);
}

/** The bot's numeric id, the part of the token before the colon. */
export function telegramBotId(botToken: string): string {
  const [rawBotId] = botToken.trim().split(":", 1);
  const botId = rawBotId?.trim() || "default";
  return botId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "default";
}

/**
 * Message ids are counted per chat and per bot, and the same person has the
 * same chat id with every bot, so the bot is part of the key.
 */
export function telegramBotKey(botToken?: string | null): string {
  return botToken?.trim() ? `bot:${telegramBotId(botToken)}` : RELAY_BOT_KEY;
}

function routeKey(botKey: string, telegramChatId: string | number, messageId: number): string {
  return `${botKey}|${String(telegramChatId).trim()}|${messageId}`;
}

// Routes are written by the bot handler, the external API and the scheduler,
// and Next compiles routes separately, so a queue held in a module variable
// could exist twice and let two writes interleave. One per process, here.
const WRITE_QUEUE = Symbol.for("eggent.telegram.routes.writeQueue");

function writeQueue(): { tail: Promise<void> } {
  const holder = globalThis as unknown as Record<symbol, { tail: Promise<void> } | undefined>;
  holder[WRITE_QUEUE] ??= { tail: Promise.resolve() };
  return holder[WRITE_QUEUE];
}

async function readRoutes(): Promise<RoutesFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(routesPath(), "utf-8")) as Partial<RoutesFile>;
    if (parsed.routes && typeof parsed.routes === "object" && !Array.isArray(parsed.routes)) {
      return { routes: parsed.routes };
    }
  } catch {
    // Missing or torn: nothing is known, so every message goes where the conversation is.
  }
  return { routes: {} };
}

async function mutateRoutes(mutate: (file: RoutesFile) => void): Promise<void> {
  const queue = writeQueue();
  const write = queue.tail.then(async () => {
    const file = await readRoutes();
    mutate(file);
    const entries = Object.entries(file.routes);
    if (entries.length > MAX_ROUTES) {
      entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [key] of entries.slice(0, entries.length - MAX_ROUTES)) delete file.routes[key];
    }
    const target = routesPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Whole or not at all: a torn file reads back as no routes.
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(file), "utf-8");
    await fs.rename(temporary, target);
  });
  queue.tail = write.catch(() => undefined);
  await write;
}

/** Remember which chat these Telegram messages came from. Never throws. */
export async function recordTelegramMessages(input: {
  botKey: string;
  telegramChatId: string | number;
  messageIds: readonly number[] | undefined;
  chatId: string | null | undefined;
}): Promise<void> {
  const ids = (input.messageIds ?? []).filter((id) => Number.isInteger(id) && id > 0);
  const chatId = input.chatId?.trim();
  if (!ids.length || !chatId) return;
  const at = new Date().toISOString();
  try {
    await mutateRoutes((file) => {
      for (const id of ids) {
        file.routes[routeKey(input.botKey, input.telegramChatId, id)] = { chatId, at };
      }
    });
  } catch (error) {
    console.warn("Failed to remember which chat a Telegram message came from:", error);
  }
}

/** The chat a Telegram message of ours came from, while that chat still exists. */
export async function chatForTelegramMessage(input: {
  botKey: string;
  telegramChatId: string | number;
  messageId: number;
}): Promise<string | null> {
  if (!Number.isInteger(input.messageId) || input.messageId <= 0) return null;
  const record = (await readRoutes()).routes[routeKey(input.botKey, input.telegramChatId, input.messageId)];
  if (!record?.chatId) return null;
  return (await getChat(record.chatId)) ? record.chatId : null;
}

/**
 * Point a session at a chat, and at the project the chat belongs to.
 *
 * The project goes with it: the chat's history was written in that project's
 * directory with that project's instructions, and continuing it from anywhere
 * else would hand the agent paths that mean nothing there.
 */
export function moveSessionToChat(
  session: ExternalSession,
  chat: { id: string; projectId?: string | null }
): void {
  setSessionChatId(session, chat.id);
  session.activeProjectId = chat.projectId ?? null;
}

/** Bind a stored session to a chat. False when the chat no longer exists. */
export async function bindTelegramSession(sessionId: string, chatId: string): Promise<boolean> {
  const chat = await getChat(chatId);
  if (!chat) return false;
  const session = await getOrCreateExternalSession(sessionId);
  moveSessionToChat(session, chat);
  session.updatedAt = new Date().toISOString();
  await saveExternalSession(session);
  return true;
}

/**
 * Which session the person behind this destination is talking through.
 *
 * The workspace's own bot keeps the mapping here. The deployment's bot keeps it
 * itself and says which one with every delivery; until it does, the session
 * that last wrote through it is the best guess there is.
 */
async function sessionForDestination(
  destination: TelegramDestination,
  reportedSessionId?: string
): Promise<string | null> {
  // No token here means the deployment's bot, whether reached as the relay or
  // as the chat a run answers - a scheduled run's session can still carry the
  // message that created it weeks ago.
  if (!destination.botToken) {
    return reportedSessionId || (await rememberedTelegramSessionId());
  }
  const botId = telegramBotId(destination.botToken);
  return (
    (await getTelegramChatSessionId(botId, destination.chatId)) ||
    createDefaultTelegramSessionId(botId, destination.chatId)
  );
}

/**
 * Record a message that went out from a chat, and move the conversation there.
 *
 * Only for the person's own chat with the bot. A post to a channel is neither
 * a reply target nor a place the person talks from, so callers leave it out.
 */
export async function afterTelegramDelivery(input: {
  destination: TelegramDestination;
  result: TelegramSendResult;
  chatId: string | null | undefined;
}): Promise<void> {
  const chatId = input.chatId?.trim();
  if (!input.result.success || !chatId) return;
  await recordTelegramMessages({
    botKey: telegramBotKey(input.destination.botToken),
    telegramChatId: input.destination.chatId,
    messageIds: input.result.messageIds,
    chatId,
  });
  try {
    const sessionId = await sessionForDestination(input.destination, input.result.sessionId);
    if (sessionId) await bindTelegramSession(sessionId, chatId);
  } catch (error) {
    console.warn("Failed to move the Telegram conversation to the chat that wrote:", error);
  }
}

/**
 * Deliver something a chat produced on its own - a scheduled run's report - to
 * the person's Telegram, saying which chat it is from, and continue there.
 */
export async function deliverChatToTelegram(input: {
  chatId: string;
  text: string;
  title?: string | null;
}): Promise<TelegramSendResult | null> {
  const text = input.text.trim();
  if (!text) return null;
  const destination = await resolveTelegramDestination(null);
  if (!destination) return null;
  // The delivery moves the conversation into this chat's project, so the
  // project button under the input field moves with it: left showing the old
  // project, pressing it would leave a project the person is no longer in.
  const chat = await getChat(input.chatId);
  const projectName = chat?.projectId ? (await getProject(chat.projectId))?.name ?? null : null;
  const replyMarkup = destination.botToken
    ? projectKeyboard(projectName, await (await import("@/i18n/server")).getServerTranslator())
    : undefined;
  const result = await sendTelegramMarkdownText(destination, withChatFooter(text, input.title), {
    replyMarkup,
    projectName,
  });
  await afterTelegramDelivery({ destination, result, chatId: input.chatId });
  return result;
}
