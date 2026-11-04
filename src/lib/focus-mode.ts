"use client";

import { useEffect, useState } from "react";

/**
 * Focus mode: the chat alone on screen - the sidebar and the header step
 * aside, the composer stays (Stop and typing must always be in reach). It is
 * `?focus=1` in the address, so a reload keeps it, and `data-eggent-focus` on
 * <html>, which the stylesheet reads (layout.tsx sets it before the first
 * paint when the address asks for it).
 */
const FOCUS_EVENT = "eggent:focus-mode";

function focusInAddress(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("focus") === "1";
}

export function setFocusMode(on: boolean): void {
  const url = new URL(window.location.href);
  if (on) url.searchParams.set("focus", "1");
  else url.searchParams.delete("focus");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  document.documentElement.toggleAttribute("data-eggent-focus", on);
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

export function useFocusMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(focusInAddress());
    sync();
    window.addEventListener(FOCUS_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(FOCUS_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  return on;
}
