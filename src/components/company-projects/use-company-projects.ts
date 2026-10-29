"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { CompanyProjectsList } from "@/lib/company-projects/types";

/**
 * The projects this person's company opened to them, shared by the sidebar and
 * the project's page. Asked once while anything shows it, every five minutes
 * after, and when the window comes back - an administrator opens or closes a
 * project rarely. Null until the first answer; `{ enabled: false }` hides it all.
 */

const POLL_MS = 5 * 60_000;

let current: CompanyProjectsList | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function refreshCompanyProjects(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/company-projects", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return;
      current = (await response.json()) as CompanyProjectsList;
      emit();
    })
    .catch(() => {
      // Keep what was shown: a missed look is not news.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function onFocus(): void {
  if (document.visibilityState === "visible") void refreshCompanyProjects();
}

function startReading(): () => void {
  readers += 1;
  if (readers === 1) {
    void refreshCompanyProjects();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshCompanyProjects();
    }, POLL_MS);
    window.addEventListener("focus", onFocus);
  }
  return () => {
    readers -= 1;
    if (readers === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onFocus);
    }
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCompanyProjects(): CompanyProjectsList | null {
  useEffect(() => startReading(), []);
  return useSyncExternalStore(subscribe, () => current, () => null);
}
