import fs from "fs/promises";
import path from "path";
import { getTelegramIntegrationRuntimeConfig } from "@/lib/storage/telegram-integration-store";

/**
 * Outgoing Telegram delivery for this workspace.
 *
 * Sending used to be possible only while answering a Telegram message, because
 * the bot token and chat id arrived with that request and lived nowhere else.
 * Anything that ran later - a scheduled job, a background agent, a follow-up
 * from the web chat - had nothing to deliver with, which is why "send me the
 * report at 07:00" never arrived for anyone who asked for it.
 *
 * A destination is therefore remembered per workspace, and delivery goes
 * through whichever of these is available, in order:
 *
 *  1. the chat this run is answering, when there is one;
 *  2. the workspace's own bot plus the last chat that talked to it;
 *  3. a relay operated by the deployment, for workspaces whose bot belongs to
 *     the operator rather than to the user. The relay keeps that bot's token
 *     out of the workspace entirely - it is one token shared by every
 *     workspace, and the agent can read any file this process can.
 *
 * Self-hosted Eggent configures no relay, so only 1 and 2 apply and nothing
 * about this file requires a hosted deployment.
 */

const OUTBOX_FILENAME = "telegram-outbox.json";

export type TelegramDestinationKind = "run" | "workspace-bot" | "relay";

export interface TelegramDestination {
  kind: TelegramDestinationKind;
  chatId: string | number;
  /** Present only when this process may talk to the Bot API directly. */
  botToken?: string;
  replyToMessageId?: number | null;
}

export interface TelegramRelayConfig {
  url: string;
  token?: string;
}

interface StoredOutbox {
  chatId?: string | number;
  replyToMessageId?: number | null;
  /** Which channel last spoke to this workspace: its own bot, or the relay. */
  via?: TelegramDestinationKind;
  updatedAt?: string;
}

function outboxPath(): string {
  return path.join(process.cwd(), "data", OUTBOX_FILENAME);
}

export function getTelegramRelayConfig(): TelegramRelayConfig | null {
  const url = process.env.EGGENT_TELEGRAM_RELAY_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token =
    process.env.EGGENT_TELEGRAM_RELAY_TOKEN?.trim() ||
    process.env.EGGENT_USAGE_API_TOKEN?.trim() ||
    undefined;
  return { url: url.replace(/\/+$/, ""), token };
}

async function readOutbox(): Promise<StoredOutbox | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(outboxPath(), "utf-8")) as StoredOutbox;
    if (!parsed || typeof parsed !== "object") return null;
    const chatId = parsed.chatId;
    if (typeof chatId !== "string" && typeof chatId !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remember where to reach this user later. Called for every Telegram-attached
 * run; the token is deliberately not stored, only where to send.
 */
export async function rememberTelegramDestination(input: {
  chatId: string | number;
  replyToMessageId?: number | null;
  via: TelegramDestinationKind;
}): Promise<void> {
  const filePath = outboxPath();
  const record: StoredOutbox = {
    chatId: input.chatId,
    replyToMessageId: input.replyToMessageId ?? null,
    via: input.via,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn("Failed to remember the Telegram destination:", error);
  }
}

/**
 * Turn what a person pasted into something the Bot API accepts.
 *
 * People hand over `@name`, a `t.me/...` link, or the bare number a client
 * shows for a channel. Only the first two are unambiguous.
 */
export function normalizeChatTarget(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const link = /^(?:https?:\/\/)?t\.me\/(?:c\/(\d+)(?:\/.*)?|([A-Za-z][\w]{3,}))\/?$/.exec(value);
  if (link) return link[1] ? link[1] : `@${link[2]}`;
  if (/^@[A-Za-z][\w]{3,}$/.test(value)) return value;
  if (/^-?\d+$/.test(value)) return value;
  if (/^[A-Za-z][\w]{3,}$/.test(value)) return `@${value}`;
  return null;
}

/**
 * Forms of a chat id worth trying, in order.
 *
 * A channel id copied from a `t.me/c/<id>` link, or from a client that shows
 * the bare number, needs the `-100` prefix the Bot API expects. User ids are
 * the same shape, so the prefixed form is only ever tried after Telegram has
 * refused the plain one.
 */
function chatIdCandidates(chatId: string | number): string[] {
  const raw = String(chatId).trim();
  if (/^\d{9,}$/.test(raw)) return [raw, `-100${raw}`];
  return [raw];
}

function isChatNotFound(description?: string): boolean {
  return /chat not found|chat_id is empty|peer_id_invalid/i.test(description || "");
}

type BotApiOutcome = { ok: boolean; status: number; description?: string };

/**
 * Call one Bot API method, retrying the alternate channel-id form once if the
 * first attempt is refused for not existing.
 */
async function callBotApi(
  token: string,
  method: string,
  chatId: string | number,
  build: (chat: string) => { body: BodyInit; headers?: Record<string, string> }
): Promise<BotApiOutcome> {
  let last: BotApiOutcome = { ok: false, status: 0 };
  for (const candidate of chatIdCandidates(chatId)) {
    const { body, headers } = build(candidate);
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers, body });
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (response.ok && payload?.ok) return { ok: true, status: response.status };
    last = { ok: false, status: response.status, description: payload?.description };
    if (!isChatNotFound(payload?.description)) break;
  }
  return last;
}

/**
 * Where an outgoing message should go right now.
 *
 * `runDestination` is the chat of the message being answered, when the caller
 * has one. Everything else falls back to what the workspace remembers.
 *
 * `chat` names a different destination outright - a channel the bot administers,
 * or another chat. It needs this workspace's own bot: the deployment relay only
 * delivers to chats already bound to the workspace, by design.
 */
export async function resolveTelegramDestination(
  runDestination?: { chatId: string | number; botToken?: string; replyToMessageId?: number | null } | null,
  options: { chat?: string } = {}
): Promise<TelegramDestination | null> {
  const explicit = options.chat ? normalizeChatTarget(options.chat) : null;
  if (options.chat && !explicit) return null;
  if (explicit) {
    const config = await getTelegramIntegrationRuntimeConfig().catch(() => null);
    if (!config?.botToken) return null;
    // No reply id: the target is a different chat from the one being answered.
    return { kind: "workspace-bot", chatId: explicit, botToken: config.botToken };
  }

  if (runDestination && runDestination.chatId !== undefined && runDestination.chatId !== null) {
    return {
      kind: "run",
      chatId: runDestination.chatId,
      botToken: runDestination.botToken,
      replyToMessageId: runDestination.replyToMessageId ?? null,
    };
  }

  const stored = await readOutbox();
  if (!stored?.chatId) return null;

  if (stored.via !== "relay") {
    const config = await getTelegramIntegrationRuntimeConfig().catch(() => null);
    if (config?.botToken) {
      return { kind: "workspace-bot", chatId: stored.chatId, botToken: config.botToken };
    }
  }

  if (getTelegramRelayConfig()) {
    return { kind: "relay", chatId: stored.chatId };
  }

  return null;
}

/** Files go to the relay as base64 JSON; the relay speaks no multipart. */
const RELAY_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

async function relayFetch(pathname: string, payload: unknown): Promise<Response> {
  const relay = getTelegramRelayConfig();
  if (!relay) throw new Error("No Telegram relay is configured for this deployment.");
  return fetch(`${relay.url}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(relay.token ? { Authorization: `Bearer ${relay.token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

export interface TelegramSendResult {
  success: boolean;
  error?: string;
  via?: TelegramDestinationKind;
}

export async function sendTelegramText(
  destination: TelegramDestination,
  text: string
): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: "Message text is empty." };

  try {
    if (destination.botToken) {
      const outcome = await callBotApi(destination.botToken, "sendMessage", destination.chatId, (chat) => ({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: trimmed,
          ...(destination.replyToMessageId ? { reply_to_message_id: destination.replyToMessageId } : {}),
        }),
      }));
      if (!outcome.ok) {
        return {
          success: false,
          via: destination.kind,
          error: `Telegram sendMessage failed (${outcome.status})${outcome.description ? `: ${outcome.description}` : ""}`,
        };
      }
      return { success: true, via: destination.kind };
    }

    const response = await relayFetch("/message", { chatId: destination.chatId, text: trimmed });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      return { success: false, via: "relay", error: payload?.error || `Relay returned ${response.status}` };
    }
    return { success: true, via: "relay" };
  } catch (error) {
    return {
      success: false,
      via: destination.kind,
      error: error instanceof Error ? error.message : "Failed to send the Telegram message.",
    };
  }
}

export async function sendTelegramDocument(
  destination: TelegramDestination,
  file: { buffer: Buffer; name: string; caption?: string }
): Promise<TelegramSendResult> {
  try {
    if (destination.botToken) {
      const outcome = await callBotApi(destination.botToken, "sendDocument", destination.chatId, (chat) => {
        const form = new FormData();
        form.append("chat_id", chat);
        form.append("document", new Blob([new Uint8Array(file.buffer)]), file.name);
        if (file.caption?.trim()) form.append("caption", file.caption.trim());
        return { body: form };
      });
      if (!outcome.ok) {
        return {
          success: false,
          via: destination.kind,
          error: `Telegram sendDocument failed (${outcome.status})${outcome.description ? `: ${outcome.description}` : ""}`,
        };
      }
      return { success: true, via: destination.kind };
    }

    if (file.buffer.byteLength > RELAY_DOCUMENT_MAX_BYTES) {
      return {
        success: false,
        via: "relay",
        error: `File is too large to send through this deployment (${file.buffer.byteLength} bytes, max ${RELAY_DOCUMENT_MAX_BYTES}).`,
      };
    }
    const response = await relayFetch("/document", {
      chatId: destination.chatId,
      name: file.name,
      caption: file.caption?.trim() || undefined,
      contentBase64: file.buffer.toString("base64"),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      return { success: false, via: "relay", error: payload?.error || `Relay returned ${response.status}` };
    }
    return { success: true, via: "relay" };
  } catch (error) {
    return {
      success: false,
      via: destination.kind,
      error: error instanceof Error ? error.message : "Failed to send the file to Telegram.",
    };
  }
}

/** Image extensions Telegram will show inline rather than as an attachment. */
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

export function looksLikePhoto(fileName: string): boolean {
  return PHOTO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/**
 * Send an image as a picture rather than as an attachment.
 *
 * A post is a picture with a caption; a document is a paperclip. Only
 * `sendDocument` existed, so every generated image arrived as a file to
 * download - which is what people reported as "the image came as a file again".
 *
 * The deployment relay carries documents only, so a workspace delivering
 * through the relay falls back to that rather than failing.
 */
export async function sendTelegramPhoto(
  destination: TelegramDestination,
  file: { buffer: Buffer; name: string; caption?: string }
): Promise<TelegramSendResult> {
  if (!destination.botToken) return sendTelegramDocument(destination, file);
  try {
    const outcome = await callBotApi(destination.botToken, "sendPhoto", destination.chatId, (chat) => {
      const form = new FormData();
      form.append("chat_id", chat);
      form.append("photo", new Blob([new Uint8Array(file.buffer)]), file.name);
      if (file.caption?.trim()) form.append("caption", file.caption.trim());
      return { body: form };
    });
    if (!outcome.ok) {
      return {
        success: false,
        via: destination.kind,
        error: `Telegram sendPhoto failed (${outcome.status})${outcome.description ? `: ${outcome.description}` : ""}`,
      };
    }
    return { success: true, via: destination.kind };
  } catch (error) {
    return {
      success: false,
      via: destination.kind,
      error: error instanceof Error ? error.message : "Failed to send the photo to Telegram.",
    };
  }
}

/** Whether this workspace can deliver anything to Telegram at all. */
export async function hasTelegramDestination(): Promise<boolean> {
  return (await resolveTelegramDestination(null)) !== null;
}

/**
 * Record the destination carried by an incoming run, if it carries one.
 *
 * `via` is decided by the caller, not guessed from the payload: a message
 * forwarded by the deployment's bot may well arrive with that bot's token, but
 * the token is not this workspace's to keep, so later deliveries to that chat
 * must go back out through the relay.
 */
export async function rememberTelegramDestinationFromRuntime(
  toolRuntimeData: Record<string, unknown> | undefined,
  via: TelegramDestinationKind
): Promise<void> {
  const raw = toolRuntimeData?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const record = raw as Record<string, unknown>;
  const chatId = record.chatId;
  if (typeof chatId !== "string" && typeof chatId !== "number") return;
  const replyToMessageId = typeof record.replyToMessageId === "number" ? record.replyToMessageId : null;
  await rememberTelegramDestination({ chatId, replyToMessageId, via });
}
