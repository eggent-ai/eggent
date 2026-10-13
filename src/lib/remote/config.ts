import { parseHome, type ChatHome } from "@/lib/remote/types";

/**
 * Whether this process can hand a chat to the other side, and who it is.
 *
 * Everything here comes from the environment of whoever runs the process: the
 * deployment that hosts the workspace, or the app on a computer. A plain
 * self-hosted install sets none of it, and then chats behave exactly as they
 * always did - a stored `home` is read as if it were not there.
 */

/** This process as a chat home: "cloud" in a workspace, `device:<id>` in the app. */
export function localNode(): ChatHome | null {
  return parseHome(process.env.EGGENT_REMOTE_NODE) ?? null;
}

/** What this process is called in the switch, when it is a computer. */
export function localNodeName(): string | null {
  const name = process.env.EGGENT_REMOTE_NODE_NAME?.trim();
  return name ? name.slice(0, 80) : null;
}

/** Where the other side is reached, without a trailing slash; http(s) only. */
export function relayBaseUrl(): string | null {
  const raw = process.env.EGGENT_REMOTE_RELAY_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The credential for that address. It is the one the usage meter already uses. */
export function relayToken(): string | null {
  const token = (process.env.EGGENT_REMOTE_RELAY_TOKEN || process.env.EGGENT_USAGE_API_TOKEN || "").trim();
  return token || null;
}

export function remoteEnabled(): boolean {
  return Boolean(localNode() && relayBaseUrl() && relayToken());
}

/**
 * Whether a chat's stored home means "not here".
 *
 * False for no home, for this process's own, and everywhere the feature is
 * off - which is what keeps a chat that was switched to a computer from being
 * handed to nowhere when it is opened on a install that has no computer.
 */
export function isRemoteHome(home: ChatHome | null | undefined): home is ChatHome {
  if (!home || !remoteEnabled()) return false;
  return home !== localNode();
}

function seconds(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * How long the receiving side waits for the files of a chat to arrive before it
 * refuses the turn. Sync is eventual; this is the patience, not a guarantee.
 */
export function coverWaitMs(): number {
  return seconds("EGGENT_REMOTE_COVER_WAIT_SECONDS", 30, 1, 300) * 1000;
}

/**
 * How long the sending side waits, after the answer has streamed, for the
 * stored chat to arrive before it lets the screen go. The screen reloads the
 * stored chat when a turn ends, and one that does not hold the answer yet would
 * take it off the screen.
 */
export function settleWaitMs(): number {
  return seconds("EGGENT_REMOTE_SETTLE_WAIT_SECONDS", 25, 1, 300) * 1000;
}

/** How long the other side has to start answering before the request is given up on. */
export function relayHeadersTimeoutMs(): number {
  return seconds("EGGENT_REMOTE_RELAY_HEADERS_SECONDS", 150, 5, 600) * 1000;
}
