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

function secret(purpose: string): string {
  // The same secret the session cookie is signed with, put to a different use for each kind of token.
  const base = process.env.EGGENT_AUTH_SECRET?.trim() || "eggent-default-auth-secret-change-me";
  return createHmac("sha256", base).update(purpose).digest("hex");
}

const PAGE_PURPOSE = "eggent-page-token-v1";
const SHARE_PURPOSE = "eggent-share-page-token-v1";

function sign(payload: string, purpose = PAGE_PURPOSE): string {
  return createHmac("sha256", secret(purpose)).update(payload).digest("base64url");
}

function readSigned(token: string, purpose: string, now: number): Record<string, unknown> | null {
  const [payload, signature] = String(token || "").split(".", 2);
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, purpose));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed.e !== "number" || parsed.e <= now) return null;
    return parsed;
  } catch {
    return null;
  }
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
  const parsed = readSigned(token, PAGE_PURPOSE, now);
  if (!parsed || typeof parsed.p !== "string" || !parsed.p) return null;
  return { project: parsed.p, expires: parsed.e as number };
}

/** Where a file of a scope is served on screen, the path's segments encoded one by one. */
export function pageUrl(project: string, filePath: string, mode?: "edit" | "print"): string {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent);
  return `/api/files/page/${mintPageToken(project)}/${segments.join("/")}${mode ? `?eggent=${mode}` : ""}`;
}

/**
 * The key in the address of a page a colleague shared: it names the share and
 * the page's own file name, which the frame's relative links resolve beside.
 * Signed for this use only, so a key for one of this workspace's own folders
 * cannot be taken for one, nor one for the other.
 */
export interface SharePageToken {
  share: string;
  /** The page's file name: the one path under the key that is the page itself. */
  fileName: string;
  expires: number;
}

export function mintSharePageToken(shareId: string, fileName: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ s: shareId, f: fileName, e: now + TOKEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, SHARE_PURPOSE)}`;
}

export function readSharePageToken(token: string, now = Date.now()): SharePageToken | null {
  const parsed = readSigned(token, SHARE_PURPOSE, now);
  if (!parsed || typeof parsed.s !== "string" || !parsed.s || typeof parsed.f !== "string" || !parsed.f) return null;
  return { share: parsed.s, fileName: parsed.f, expires: parsed.e as number };
}

/** Where a shared page is served on screen. */
export function sharePageUrl(shareId: string, fileName: string, mode?: "edit" | "pick" | "print"): string {
  const name = fileName.split("/").pop() || "page.html";
  return `/api/shares/page/${mintSharePageToken(shareId, name)}/${encodeURIComponent(name)}${mode ? `?eggent=${mode}` : ""}`;
}
