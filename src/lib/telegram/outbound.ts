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
 * Where an outgoing message should go right now.
 *
 * `runDestination` is the chat of the message being answered, when the caller
 * has one. Everything else falls back to what the workspace remembers.
 */
export async function resolveTelegramDestination(
  runDestination?: { chatId: string | number; botToken?: string; replyToMessageId?: number | null } | null
): Promise<TelegramDestination | null> {
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
      const response = await fetch(`https://api.telegram.org/bot${destination.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: destination.chatId,
          text: trimmed,
          ...(destination.replyToMessageId ? { reply_to_message_id: destination.replyToMessageId } : {}),
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
      if (!response.ok || !payload?.ok) {
        return {
          success: false,
          via: destination.kind,
          error: `Telegram sendMessage failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`,
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
      const form = new FormData();
      form.append("chat_id", String(destination.chatId));
      form.append("document", new Blob([new Uint8Array(file.buffer)]), file.name);
      if (file.caption?.trim()) form.append("caption", file.caption.trim());
      const response = await fetch(`https://api.telegram.org/bot${destination.botToken}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string } | null;
      if (!response.ok || !payload?.ok) {
        return {
          success: false,
          via: destination.kind,
          error: `Telegram sendDocument failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`,
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
