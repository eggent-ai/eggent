"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** How long after mount a key is part of the first load rather than an arrival. */
const SETTLE_MS = 1500;
/** More than this at once is a list being replaced, not something arriving. */
const MAX_AT_ONCE = 2;
/** Long enough for the entrance to finish. */
const FRESH_MS = 400;

/**
 * Which keys of a list have just arrived, so only those animate in.
 *
 * Not the first load (it lands inside the first moments, or many at once), and
 * not a list swapped for another one (switching projects replaces every chat:
 * nothing of the old list stays). One or two new keys beside ones already
 * there, or into an empty list, are an arrival. Decided in a layout effect, so
 * the row is drawn with its entrance from the first frame.
 */
export function useArrivals(keys: readonly string[]): (key: string) => boolean {
  const seen = useRef<Set<string> | null>(null);
  const mountedAt = useRef(0);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join("\u0000");

  useLayoutEffect(() => {
    const now = performance.now();
    if (!mountedAt.current) mountedAt.current = now;
    const previous = seen.current;
    seen.current = new Set(keys);
    if (!previous || now - mountedAt.current < SETTLE_MS) return;
    const added = keys.filter((key) => !previous.has(key));
    if (added.length === 0 || added.length > MAX_AT_ONCE) return;
    const kept = previous.size === 0 || keys.some((key) => previous.has(key));
    if (!kept) return;
    setFresh(new Set(added));
    const timer = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => window.clearTimeout(timer);
    // `signature` stands for `keys`: the same list in a new array is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (key) => fresh.has(key);
}
