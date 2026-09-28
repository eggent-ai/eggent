import { createHash, randomBytes } from "node:crypto";

/**
 * One-time sign-in links.
 *
 * Something already signed in to this workspace can ask for a link that signs
 * one browser in without the password being typed again. The case it was
 * written for is a tool that has just set a workspace up for somebody, and
 * already holds a session of its own: sending that person to the sign-in form
 * made them type back the password they had chosen seconds earlier, and some
 * mistyped it on the way in.
 *
 * A token is good for one use and ten minutes. Only its hash is kept, in memory,
 * so a restart simply invalidates every link that was still outstanding.
 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

// Enough for any honest use; a burst of requests evicts the oldest instead of
// growing the map.
const MAX_OUTSTANDING = 50;

interface OutstandingHandoff {
  username: string;
  expiresAt: number;
}

// On globalThis rather than in module scope: the route that mints and the
// route that redeems are compiled separately, and a module-level map can be
// handed to each of them as its own empty copy.
const holder = globalThis as typeof globalThis & {
  __eggentAuthHandoffs?: Map<string, OutstandingHandoff>;
};

function outstanding(): Map<string, OutstandingHandoff> {
  if (!holder.__eggentAuthHandoffs) holder.__eggentAuthHandoffs = new Map();
  return holder.__eggentAuthHandoffs;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneExpired(now: number): void {
  const entries = outstanding();
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

export function mintHandoffToken(username: string, now = Date.now()): { token: string; expiresAt: number } {
  pruneExpired(now);
  const entries = outstanding();
  while (entries.size >= MAX_OUTSTANDING) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + HANDOFF_TTL_MS;
  entries.set(hashToken(token), { username, expiresAt });
  return { token, expiresAt };
}

/**
 * Spends a token. Whatever the outcome, the same token never works twice.
 */
export function redeemHandoffToken(token: unknown, now = Date.now()): { username: string } | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  // A minted token is 43 characters; anything far off that was never one.
  if (trimmed.length < 32 || trimmed.length > 128) return null;
  const key = hashToken(trimmed);
  const entries = outstanding();
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  if (entry.expiresAt <= now) return null;
  return { username: entry.username };
}
