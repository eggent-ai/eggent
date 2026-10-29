"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether this workspace has a mailbox and what is unread in it, shared by the
 * sidebar and the Mail screens. Asked once a minute while anything shows it,
 * when the window comes back, and at once after a letter is read
 * (`refreshEmailStatus`). Null until the first answer.
 */

export type EmailStatusAnswer = { enabled: false } | { enabled: true; address: string | null; unread: { inbox: number; other: number } };

const POLL_MS = 60_000;

let current: EmailStatusAnswer | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function refreshEmailStatus(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/email/status", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      current = (await response.json()) as EmailStatusAnswer;
      emit();
    })
    .catch(() => {
      // Keep what was shown: a missed poll is not news.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function onFocus(): void {
  if (document.visibilityState === "visible") void refreshEmailStatus();
}

function startReading(): () => void {
  readers += 1;
  if (readers === 1) {
    void refreshEmailStatus();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshEmailStatus();
    }, POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
  }
  return () => {
    readers -= 1;
    if (readers === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    }
  };
}

export function useEmailStatus(): EmailStatusAnswer | null {
  useEffect(() => startReading(), []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null
  );
}
