"use client";

import { useEffect, useState } from "react";
import type { UiSyncEvent, UiSyncTopic } from "@/lib/realtime/types";

interface BackgroundSyncOptions {
  topics?: UiSyncTopic[];
  projectId?: string | null;
  chatId?: string | null;
  fallbackIntervalMs?: number;
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
    let eventSource: EventSource | null = null;
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

    const onSync = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as UiSyncEvent;
        if (!matchesScope(parsed, scope)) {
          return;
        }
        bump();
      } catch {
        // Ignore malformed SSE event payloads.
      }
    };

    const connect = () => {
      eventSource = new EventSource("/api/events");
      eventSource.addEventListener("sync", onSync as EventListener);
    };

    connect();

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
      if (eventSource) {
        eventSource.removeEventListener("sync", onSync as EventListener);
        eventSource.close();
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [chatId, projectId, fallbackIntervalMs, topicsKey]);

  return tick;
}
