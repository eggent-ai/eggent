"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadEngines, type EnginesResponse } from "@/lib/engines/client";

/**
 * The programs of this computer a project could run on, kept fresh the way a
 * person would expect: looked at again when the window comes back to the front
 * (they may just have signed in, in a browser), and every couple of seconds
 * while a sign-in they started is still waiting for them.
 *
 * `null` until the first answer, so a screen can stay out of sight until it
 * knows whether there is anything to show.
 */
export function useEngines(projectId: string | null | undefined): {
  state: EnginesResponse | null;
  refresh: (fresh?: boolean) => Promise<void>;
} {
  const [state, setState] = useState<EnginesResponse | null>(null);
  const scope = projectId ?? null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refresh = useCallback(async (fresh = false) => {
    const wanted = scopeRef.current;
    const next = await loadEngines(wanted, { fresh });
    // An answer for a project that has since been left is no answer.
    if (next && scopeRef.current === wanted) setState(next);
  }, []);

  useEffect(() => {
    setState(null);
    void refresh();
  }, [scope, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const waiting = state?.engines.some((engine) => engine.loggingIn) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(true), 2000);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  return { state, refresh };
}
