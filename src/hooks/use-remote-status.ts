"use client";

import { useCallback, useEffect, useState } from "react";
import type { RemoteStatus } from "@/lib/remote/types";

/**
 * Whether this install can run a chat on the other side of a paired workspace
 * and computer, and which computers a workspace could hand one to right now.
 *
 * Fetched on arrival and on every background sync tick, because a computer
 * comes and goes with its app. A failed fetch keeps what was last known: a
 * switch that vanishes on a bad network is worse than one that is a minute stale.
 */
export function useRemoteStatus(syncTick = 0): { status: RemoteStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<RemoteStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/status", { cache: "no-store" });
      if (!response.ok) return;
      setStatus((await response.json()) as RemoteStatus);
    } catch {
      // keep what was known
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, syncTick]);

  return { status, refresh };
}
