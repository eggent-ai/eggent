import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The key in the address of a page shown on screen.
 *
 * A page is shown in a sandboxed frame, which has no origin of its own, so the
 * browser sends it no session cookie and its pictures and styles could not be
 * fetched the ordinary way. Instead the page and everything beside it are
 * served under `/api/files/page/<token>/...`: the token names one project's
 * folder and an expiry, is signed with this workspace's own secret, and is
 * handed only to a signed-in person. Relative links in the page resolve under
 * it, so a site of several files shows as it will on any host.
 */

const TOKEN_TTL_MS = 30 * 60_000;

function secret(): string {
  // The same secret the session cookie is signed with, put to a different use.
  const base = process.env.EGGENT_AUTH_SECRET?.trim() || "eggent-default-auth-secret-change-me";
  return createHmac("sha256", base).update("eggent-page-token-v1").digest("hex");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export interface PageToken {
  /** The scope the files are served from: a project id, or "none" for the orchestrator's folder. */
  project: string;
  /** Milliseconds since the epoch. */
  expires: number;
}

export function mintPageToken(project: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: project, e: now + TOKEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readPageToken(token: string, now = Date.now()): PageToken | null {
  const [payload, signature] = String(token || "").split(".", 2);
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: unknown; e?: unknown };
    if (typeof parsed.p !== "string" || !parsed.p || typeof parsed.e !== "number") return null;
    if (parsed.e <= now) return null;
    return { project: parsed.p, expires: parsed.e };
  } catch {
    return null;
  }
}

/** Where a file of a scope is served on screen, the path's segments encoded one by one. */
export function pageUrl(project: string, filePath: string, mode?: "edit" | "print"): string {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent);
  return `/api/files/page/${mintPageToken(project)}/${segments.join("/")}${mode ? `?eggent=${mode}` : ""}`;
}
