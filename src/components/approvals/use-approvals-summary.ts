"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { ApprovalsSummary } from "@/lib/approvals/types";

/**
 * Whether this workspace has approvals, and what waits for its person, shared
 * by the sidebar, the Approvals screens and the button beside a file. One
 * request serves every reader; it is asked again every minute while anything
 * shows it, when the window comes back into focus, and at once after anything
 * sends or decides (`refreshApprovalsSummary`). Null until the first answer;
 * `{ enabled: false }` hides everything about approvals.
 */

const POLL_MS = 60_000;

let current: ApprovalsSummary | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function refreshApprovalsSummary(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/approvals/summary", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      current = (await response.json()) as ApprovalsSummary;
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
  if (document.visibilityState === "visible") void refreshApprovalsSummary();
}

function startReading(): () => void {
  readers += 1;
  if (readers === 1) {
    void refreshApprovalsSummary();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshApprovalsSummary();
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

export function useApprovalsSummary(): ApprovalsSummary | null {
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
