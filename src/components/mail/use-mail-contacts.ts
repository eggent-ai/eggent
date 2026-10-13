"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { MailContactsAnswer } from "@/lib/mail/types";

/**
 * Who this workspace can write to and what is unread, shared by the sidebar
 * and the Messages screens. One request serves every mounted reader; it is
 * asked again every minute while anything shows it, when the window comes
 * back into focus, and at once after anything sends or reads
 * (`refreshMailContacts`). Null until the first answer; `{ enabled: false }`
 * when the workspace has no messages, which hides the section.
 */

const POLL_MS = 60_000;

let current: MailContactsAnswer | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function refreshMailContacts(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/mail/contacts", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      const data = (await response.json()) as MailContactsAnswer;
      current = data;
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
  if (document.visibilityState === "visible") void refreshMailContacts();
}

function startReading(): () => void {
  readers += 1;
  if (readers === 1) {
    void refreshMailContacts();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshMailContacts();
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

export function useMailContacts(): MailContactsAnswer | null {
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
