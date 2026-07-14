import { clearAllMemoryCaches } from "@/lib/memory/memory";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { getSyncthingEvents, isSyncthingRuntimeConfigured } from "@/lib/syncthing/client";

const globalForSyncthing = globalThis as typeof globalThis & {
  __eggentSyncthingLifecycleStarted?: boolean;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watchSyncthingEvents(): Promise<void> {
  let since = 0;

  while (true) {
    try {
      const events = await getSyncthingEvents(since);
      if (events.length > 0) {
        for (const event of events) {
          if (typeof event.id === "number") since = Math.max(since, event.id);
        }
        if (events.some((event) => event.type === "ItemFinished")) {
          clearAllMemoryCaches();
        }
        publishUiSyncEvent({
          topic: "global",
          reason: "syncthing_data_changed",
        });
      }
    } catch {
      // Syncthing may still be starting or temporarily disconnected.
      await wait(10_000);
    }
  }
}

export function initSyncthingLifecycle(): void {
  if (!isSyncthingRuntimeConfigured() || globalForSyncthing.__eggentSyncthingLifecycleStarted) {
    return;
  }

  globalForSyncthing.__eggentSyncthingLifecycleStarted = true;
  void watchSyncthingEvents();
}
