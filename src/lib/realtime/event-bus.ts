import type { UiSyncEvent, UiSyncTopic } from "@/lib/realtime/types";

type UiSyncListener = (event: UiSyncEvent) => void;

interface UiSyncBusState {
  nextListenerId: number;
  nextEventId: number;
  listeners: Map<number, UiSyncListener>;
}

const BUS_KEY = "__EGGENT_UI_SYNC_BUS_STATE__";

function getBusState(): UiSyncBusState {
  const globalWithBus = globalThis as typeof globalThis & {
    [BUS_KEY]?: UiSyncBusState;
  };

  if (!globalWithBus[BUS_KEY]) {
    globalWithBus[BUS_KEY] = {
      nextListenerId: 1,
      nextEventId: 1,
      listeners: new Map<number, UiSyncListener>(),
    };
  }

  return globalWithBus[BUS_KEY];
}

export function publishUiSyncEvent(input: {
  topic: UiSyncTopic;
  projectId?: string | null;
  chatId?: string;
  reason?: string;
}): UiSyncEvent {
  const state = getBusState();
  const event: UiSyncEvent = {
    id: state.nextEventId++,
    topic: input.topic,
    at: new Date().toISOString(),
    projectId:
      input.projectId === undefined ? undefined : input.projectId ?? null,
    chatId: input.chatId,
    reason: input.reason,
  };

  for (const listener of state.listeners.values()) {
    try {
      listener(event);
    } catch {
      // Keep bus resilient to listener failures.
    }
  }

  return event;
}

export function subscribeUiSyncEvents(
  listener: UiSyncListener
): () => void {
  const state = getBusState();
  const id = state.nextListenerId++;
  state.listeners.set(id, listener);
  return () => {
    state.listeners.delete(id);
  };
}
