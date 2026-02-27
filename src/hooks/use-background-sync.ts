"use client";

import { useEffect, useState } from "react";
import type { UiSyncEvent, UiSyncTopic } from "@/lib/realtime/types";

interface BackgroundSyncOptions {
  topics?: UiSyncTopic[];
  projectId?: string | null;
  chatId?: string | null;
  fallbackIntervalMs?: number;
}

type SyncSubscriber = (event: UiSyncEvent) => void;

let sharedEventSource: EventSource | null = null;
let sharedSyncListener: ((event: MessageEvent<string>) => void) | null = null;
let nextSubscriberId = 1;
const syncSubscribers = new Map<number, SyncSubscriber>();

function ensureSharedEventSource(): void {
  if (sharedEventSource) {
    return;
  }

  sharedEventSource = new EventSource("/api/events");
  sharedSyncListener = (event: MessageEvent<string>) => {
    let parsed: UiSyncEvent | null = null;
    try {
      parsed = JSON.parse(event.data) as UiSyncEvent;
    } catch {
      return;
    }

    for (const subscriber of syncSubscribers.values()) {
      try {
        subscriber(parsed);
      } catch {
        // Keep fan-out resilient to individual listener failures.
      }
    }
  };

  sharedEventSource.addEventListener("sync", sharedSyncListener as EventListener);
}

function subscribeSharedSync(subscriber: SyncSubscriber): () => void {
  ensureSharedEventSource();
  const subscriberId = nextSubscriberId++;
  syncSubscribers.set(subscriberId, subscriber);

  return () => {
    syncSubscribers.delete(subscriberId);
    if (syncSubscribers.size === 0 && sharedEventSource) {
      if (sharedSyncListener) {
        sharedEventSource.removeEventListener(
          "sync",
          sharedSyncListener as EventListener
        );
      }
      sharedEventSource.close();
      sharedEventSource = null;
      sharedSyncListener = null;
    }
  };
}

function matchesScope(
  event: UiSyncEvent,
  options: BackgroundSyncOptions
): boolean {
  if (options.topics && options.topics.length > 0) {
    if (!options.topics.includes(event.topic)) {
      return false;
    }
  }

  if (event.topic === "projects" || event.topic === "global") {
    return true;
  }

  const expectedProject = options.projectId ?? null;
  if (options.projectId !== undefined) {
    const eventProject = event.projectId ?? null;
    if (eventProject !== expectedProject) {
      return false;
    }
  }

  if (options.chatId !== undefined && options.chatId !== null) {
    if (!event.chatId || event.chatId !== options.chatId) {
      return false;
    }
  }

  return true;
}

export function useBackgroundSync(options: BackgroundSyncOptions = {}): number {
  const fallbackIntervalMs = options.fallbackIntervalMs ?? 30000;
  const topicsKey = options.topics?.join(",") ?? "";
  const projectId = options.projectId;
  const chatId = options.chatId;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const scope: BackgroundSyncOptions = {
      topics: topicsKey
        ? (topicsKey.split(",").filter(Boolean) as UiSyncTopic[])
        : undefined,
      projectId,
      chatId,
    };

    const bump = () => {
      if (document.visibilityState !== "visible") return;
      setTick((value) => value + 1);
    };

    const onSync = (parsed: UiSyncEvent) => {
      if (!matchesScope(parsed, scope)) {
        return;
      }
      bump();
    };

    const unsubscribeSync = subscribeSharedSync(onSync);

    const fallbackTimer =
      fallbackIntervalMs > 0 ? window.setInterval(bump, fallbackIntervalMs) : null;

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      setTick((value) => value + 1);
    };

    const onWindowFocus = () => {
      setTick((value) => value + 1);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);

    return () => {
      if (fallbackTimer) {
        window.clearInterval(fallbackTimer);
      }
      unsubscribeSync();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [chatId, projectId, fallbackIntervalMs, topicsKey]);

  return tick;
}
