/**
 * What the screen is told about the messages said to a turn while it works.
 *
 * Client-safe: the chat panel reads these off the turn's stream, the runners
 * write them. Two shapes, because the two facts land in different places. The
 * queue is one part the runner keeps rewriting, drawn under the answer that is
 * still coming; a delivery is a part of its own at the point in the answer
 * where the agent read the message, so the person's words appear between what
 * was written before them and what was written after.
 */

export const STEER_QUEUE_PART = "data-piSteerQueue";
export const STEER_QUEUE_ID = "pi-steer-queue";
export const STEER_DELIVERED_PART = "data-piSteer";

/** A message on its way to the agent: written down, not read yet. */
export interface SteerQueueItem {
  messageId: string;
  text: string;
  createdAt: string;
}

export interface SteerQueueData {
  items: SteerQueueItem[];
}

/** A message the agent has read, at the point in the answer where it read it. */
export interface SteerDeliveredData extends SteerQueueItem {
  deliveredAt: string;
}

function isItem(value: unknown): value is SteerQueueItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.messageId === "string" && typeof record.text === "string" && typeof record.createdAt === "string";
}

export function readSteerQueue(value: unknown): SteerQueueItem[] {
  if (typeof value !== "object" || value === null) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter(isItem) : [];
}

export function readSteerDelivered(value: unknown): SteerDeliveredData | null {
  if (!isItem(value)) return null;
  const deliveredAt = (value as { deliveredAt?: unknown }).deliveredAt;
  return typeof deliveredAt === "string" ? { ...value, deliveredAt } : null;
}

/** An id a screen may give a message: what a client makes up, nothing that reaches a path or a query. */
export function isStoredMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

export function steerDeliveredPartId(messageId: string): string {
  return `pi-steer-${messageId}`;
}
