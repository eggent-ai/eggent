/**
 * Telegram webhook updates, answered at once and handled behind the answer.
 *
 * A turn can take minutes, and Telegram does not wait that long for a webhook
 * to answer: it gives up and delivers the update again, and again, while the
 * first delivery is still being worked on. So the route only checks the update
 * and hands it here, and Telegram is answered before the agent starts.
 *
 * Updates of one chat are handled in the order they came, which is what
 * polling gave for free and what keeps two quick messages from starting two
 * agents in one conversation. One exception: a message that is only text,
 * sent while that chat is busy, is handled at once, so "stop", `/reset` or a
 * correction reaches the turn that is running instead of waiting for it to
 * end. A file or a voice note still waits its turn, because preparing it
 * takes long enough for the order to matter.
 *
 * The queues live on `globalThis`: Next compiles each route on its own, and a
 * module-level map would be one copy per compiled module.
 */

import type { TelegramIntegrationRuntimeConfig } from "@/lib/storage/telegram-integration-store";
import type { TelegramUpdate } from "@/lib/telegram/telegram-message-handler";

type ProcessUpdate = (update: TelegramUpdate, runtime: TelegramIntegrationRuntimeConfig) => Promise<unknown>;

/** How often a failed update is tried before it is given up, as polling does. */
export const WEBHOOK_UPDATE_ATTEMPTS = 3;

interface WebhookQueueState {
  chats: Map<string, Promise<void>>;
}

const globalKey = Symbol.for("eggent.telegramWebhookQueue");

function state(): WebhookQueueState {
  const holder = globalThis as typeof globalThis & { [globalKey]?: WebhookQueueState };
  if (!holder[globalKey]) holder[globalKey] = { chats: new Map() };
  return holder[globalKey]!;
}

const MEDIA_FIELDS = [
  "photo",
  "document",
  "voice",
  "audio",
  "video",
  "video_note",
  "animation",
  "sticker",
] as const;

function chatKey(update: TelegramUpdate): string {
  const id = update.message?.chat?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : "none";
}

/** Text and nothing else: quick to hand over, safe to take out of order. */
export function isTextOnlyUpdate(update: TelegramUpdate): boolean {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message || typeof message.text !== "string" || !message.text.trim()) return false;
  return MEDIA_FIELDS.every((field) => message[field] === undefined);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle one update, trying again when it throws.
 *
 * The handler answers a failed turn itself and returns, so a throw means the
 * update could not be handled at all - most often Telegram could not be
 * reached to deliver the answer - and the handler has given the update back,
 * so trying again runs it rather than skipping it as a duplicate.
 */
async function runWithRetries(
  update: TelegramUpdate,
  runtime: TelegramIntegrationRuntimeConfig,
  processUpdate: ProcessUpdate,
  retryDelayMs: number
): Promise<void> {
  for (let attempt = 1; attempt <= WEBHOOK_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      await processUpdate(update, runtime);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt === WEBHOOK_UPDATE_ATTEMPTS) {
        console.error(`[Telegram Webhook] Giving up update ${String(update.update_id)} after ${attempt} attempts:`, reason);
        return;
      }
      console.warn(`[Telegram Webhook] Update ${String(update.update_id)} failed (attempt ${attempt}), retrying:`, reason);
      await wait(retryDelayMs * attempt);
    }
  }
}

/**
 * Take an update and handle it after the caller has answered Telegram.
 * Returns the promise of that handling, for tests; the route does not wait.
 */
export function enqueueTelegramWebhookUpdate(
  update: TelegramUpdate,
  runtime: TelegramIntegrationRuntimeConfig,
  processUpdate: ProcessUpdate,
  options: { retryDelayMs?: number } = {}
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const { chats } = state();
  const key = chatKey(update);
  const previous = chats.get(key);

  if (previous && isTextOnlyUpdate(update)) {
    return runWithRetries(update, runtime, processUpdate, retryDelayMs);
  }

  const next = (previous ?? Promise.resolve()).then(() =>
    runWithRetries(update, runtime, processUpdate, retryDelayMs)
  );
  chats.set(key, next);
  void next.finally(() => {
    if (chats.get(key) === next) chats.delete(key);
  });
  return next;
}
