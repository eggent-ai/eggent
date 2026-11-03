"use client";

import { useSyncExternalStore } from "react";

/**
 * A finished call's card takes a few seconds to reach the chat: the summary is
 * written, the call is put into the stored chat, the chat is read again. Until
 * then the chat shows a placeholder where the card will be, so a person who
 * hung up after a long call sees it coming rather than an unchanged screen.
 * One call at a time, so one placeholder.
 */

export interface PendingSummary {
  chatId: string;
  state: "pending" | "failed";
  since: number;
}

let current: PendingSummary | null = null;
const listeners = new Set<() => void>();

function emit(next: PendingSummary | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** The placeholder as it stands, for anything outside React. */
export function pendingSummary(): PendingSummary | null {
  return current;
}

export function startSummary(chatId: string): void {
  emit({ chatId, state: "pending", since: Date.now() });
}

export function failSummary(chatId: string): void {
  if (current?.chatId === chatId) emit({ ...current, state: "failed" });
}

export function clearSummary(chatId?: string): void {
  if (!chatId || current?.chatId === chatId) emit(null);
}

export function usePendingSummary(chatId: string | null | undefined): PendingSummary | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null
  );
  return value && chatId && value.chatId === chatId ? value : null;
}
