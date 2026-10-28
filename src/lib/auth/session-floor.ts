import { promises as fs } from "fs";
import path from "path";
import { verifySessionToken, type AuthSessionPayload } from "@/lib/auth/session";

/**
 * Sessions issued before a moment stop working.
 *
 * A session is a signed cookie, and nothing about a signature can be taken
 * back: changing the password used to leave every browser that was ever
 * signed in still signed in, for up to a week. `auth.sessionsValidAfter` in
 * the settings file is that moment, in seconds; a cookie issued earlier is
 * refused everywhere a session is checked. Changing the login or password here
 * sets it, and so may whatever sets a new password from outside (a hosted
 * workspace's reset by email).
 *
 * Read on every request by the middleware, so it is kept by the file's
 * identity and read again only when the file changes.
 */

function settingsFile(): string {
  return path.join(process.cwd(), "data", "settings", "settings.json");
}

let cached: { key: string; floor: number } | null = null;

export function forgetSessionFloorCache(): void {
  cached = null;
}

function floorOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The moment, in seconds, before which no session counts; 0 when none is set. */
export async function sessionsValidAfter(): Promise<number> {
  const file = settingsFile();
  let key: string;
  try {
    const stat = await fs.stat(file);
    key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 0;
  }
  if (cached?.key === key) return cached.floor;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { auth?: { sessionsValidAfter?: unknown } } | null;
    const floor = floorOf(parsed?.auth?.sessionsValidAfter);
    cached = { key, floor };
    return floor;
  } catch {
    // A file caught halfway through being written. The moment it last named
    // still holds; it is read again on the next request.
    return cached?.floor ?? 0;
  }
}

/** A signed session that is also not older than the last time sessions were ended. */
export async function verifyActiveSession(token: string): Promise<AuthSessionPayload | null> {
  const session = await verifySessionToken(token);
  if (!session) return null;
  return session.issuedAt >= (await sessionsValidAfter()) ? session : null;
}

/** The moment to write when every session issued so far should stop working. */
export function sessionFloorNow(): number {
  return Math.floor(Date.now() / 1000);
}
