/**
 * What a scheduled task's helper sent to the person's own Telegram chat.
 *
 * The helper does the work and finishes before its owner session starts the
 * turn that reports on it, so when the helper sends there is no run yet to
 * tell. The sends wait here, under the owner chat's id, and the report turn
 * takes them when it starts (schedule-host.ts): a text already sent means the
 * host does not send the report a second time, and replies to what was sent
 * are routed to the run's chat.
 */
import type { TelegramDestination, TelegramSendResult } from "@/lib/telegram/outbound";

export interface HelperDelivery {
  destination: TelegramDestination;
  result: TelegramSendResult;
  kind: "text" | "file";
  at: number;
}

/** A report turn starts seconds after its helper; anything older belongs to nothing. */
const KEEP_MS = 2 * 60 * 60_000;
const KEY = Symbol.for("eggent.helperDeliveries");

function pending(): Map<string, HelperDelivery[]> {
  const holder = globalThis as Record<symbol, unknown>;
  holder[KEY] ??= new Map<string, HelperDelivery[]>();
  return holder[KEY] as Map<string, HelperDelivery[]>;
}

export function noteHelperDelivery(ownerChatId: string, delivery: Omit<HelperDelivery, "at">): void {
  const map = pending();
  const list = (map.get(ownerChatId) ?? []).filter((entry) => Date.now() - entry.at < KEEP_MS);
  list.push({ ...delivery, at: Date.now() });
  map.set(ownerChatId, list);
}

export function takeHelperDeliveries(ownerChatId: string): HelperDelivery[] {
  const map = pending();
  const list = map.get(ownerChatId) ?? [];
  map.delete(ownerChatId);
  return list.filter((entry) => Date.now() - entry.at < KEEP_MS);
}

/**
 * The chat whose session started this helper, from the helper session's header:
 * pi-subagents records the parent's session file, and Eggent names a chat's
 * session file after the chat. Null when the extension did not record it.
 */
export function ownerChatIdOfHelper(ctx: { sessionManager?: { getHeader?: () => unknown } } | undefined): string | null {
  const header = ctx?.sessionManager?.getHeader?.() as { parentSession?: unknown } | null | undefined;
  const parent = typeof header?.parentSession === "string" ? header.parentSession : "";
  const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(parent);
  return match ? match[1] : null;
}
