/**
 * The Connect Google button's link, in the browser.
 *
 * The connect address is the service's to give, and the agent's answer carries
 * it (`connect.url`); the chat draws the button from that answer. The link is
 * followed only on the workspace's own address - that is where the session
 * cookie comes along, and a link to anywhere else is not this workspace's
 * button - and it carries the page to come back to.
 */

/** The connect address an `eggent_google` answer carries when it asks the person to connect. */
export function connectUrlFromToolOutput(output: unknown): string | null {
  return linkFromToolOutput(output, "connect");
}

/** The address of the file picker an `eggent_google` answer carries when it offers the person their Drive. */
export function pickUrlFromToolOutput(output: unknown): string | null {
  return linkFromToolOutput(output, "pick");
}

function linkFromToolOutput(output: unknown, key: "connect" | "pick"): string | null {
  let value: unknown = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const holder = (value as Record<string, unknown>)[key];
  const url = holder && typeof holder === "object" ? (holder as { url?: unknown }).url : null;
  return typeof url === "string" && url ? url : null;
}

/** The link on this page's own origin, with `return` set to where the person is now; null for another origin. */
export function connectHref(connectUrl: string | undefined, here: { origin: string; pathname: string; search: string }): string | null {
  if (!connectUrl) return null;
  let target: URL;
  try {
    target = new URL(connectUrl, here.origin);
  } catch {
    return null;
  }
  if (target.origin !== here.origin) return null;
  const back = new URLSearchParams(here.search);
  back.delete("google");
  back.delete("n");
  const query = back.toString();
  target.searchParams.set("return", `${here.pathname}${query ? `?${query}` : ""}`);
  return `${target.pathname}${target.search}`;
}
