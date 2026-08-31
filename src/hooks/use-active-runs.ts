"use client";

import { useEffect, useState } from "react";
import { useBackgroundSync } from "@/hooks/use-background-sync";

/**
 * Which chats have an agent working in them right now.
 *
 * Two places need this and they need to agree: the sidebar, which marks the
 * chats that are busy, and the open chat, which uses it to decide whether there
 * is a turn to attach to. So one fetch serves both - they refresh on the same
 * events, and asking twice at the same instant asks once.
 *
 * The list is refreshed from the server rather than accumulated from events:
 * a missed event would otherwise leave a mark burning over a chat that finished
 * half an hour ago, and the answer is a few dozen bytes.
 */

export interface ActiveRunSummary {
  chatId: string;
  runId: string;
  startedAt: number;
  surface: "web" | "external";
}

export interface ActiveRuns {
  /** chatId -> the run working in it. */
  byChat: Map<string, ActiveRunSummary>;
  /**
   * Ask again now, rather than waiting for the next event or the fallback poll.
   *
   * Opening a conversation is the moment this answer matters most and the
   * moment it is most likely to be stale, because nothing about clicking a chat
   * produces an event.
   */
  refresh: () => void;
  /**
   * Bumped on every refresh, whether or not anything changed.
   *
   * The open chat uses it to decide it may try attaching again: once per chat,
   * per run, per refresh. That is what lets a dropped connection recover without
   * letting a chat that answers "nothing to watch" ask again immediately.
   */
  version: number;
}

interface ActiveRunsState {
  byChat: Map<string, ActiveRunSummary>;
  version: number;
}

let current: ActiveRunsState = { byChat: new Map(), version: 0 };
let inFlight: Promise<void> | null = null;
let nextListenerId = 1;
const listeners = new Map<number, (value: ActiveRunsState) => void>();

function refresh(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = fetch("/api/chat/active-runs", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Failed to load active runs");
      return response.json() as Promise<{ runs?: ActiveRunSummary[] }>;
    })
    .then((payload) => {
      const runs = Array.isArray(payload?.runs) ? payload.runs : [];
      const byChat = new Map<string, ActiveRunSummary>();
      for (const run of runs) {
        if (run && typeof run.chatId === "string") byChat.set(run.chatId, run);
      }
      current = { byChat, version: current.version + 1 };
      for (const listener of listeners.values()) {
        try {
          listener(current);
        } catch {
          // Keep fan-out resilient to individual listener failures.
        }
      }
    })
    .catch(() => {
      // A failed poll keeps the last known answer: a marked chat going dark
      // because of one dropped request is worse than a mark a few seconds stale.
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function useActiveRuns(): ActiveRuns {
  const tick = useBackgroundSync({ topics: ["chat", "global"] });
  const [value, setValue] = useState<ActiveRunsState>(current);

  useEffect(() => {
    const id = nextListenerId++;
    listeners.set(id, setValue);
    return () => {
      listeners.delete(id);
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [tick]);

  return { byChat: value.byChat, version: value.version, refresh };
}
