import type { NextRequest } from "next/server";
import { findPublicShare, shareTokenOf, type PublicShare } from "@/lib/public-chat/shares";
import { VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE, visitorOfCookie, type VisitorRecord } from "@/lib/public-chat/visitors";

/**
 * What every route of a public link checks for itself. These routes are open
 * to anybody (middleware lets `/s/` through), so each one finds the link, the
 * visitor by their key, and - for anything that changes something - that the
 * request came from this very page: sibling workspaces are the same site, and
 * the visitor's cookie would go along with a form posted from one of them.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function fail(error: string, status: number, code: string): Response {
  return Response.json({ error, code }, { status, headers: NO_STORE });
}

/** The page's own origin, whatever the proxy in front of it says it is. */
function ownOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

export function fromThisPage(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === ownOrigin(req);
  // A browser that sends no Origin on a POST is not one this page runs in.
  return req.headers.get("sec-fetch-site") === "same-origin";
}

export function clientAddress(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export function visitorCookieOf(req: NextRequest): string | undefined {
  return req.cookies.get(VISITOR_COOKIE)?.value;
}

/** Set-Cookie for the visitor's key, kept to this link's own addresses. */
export function visitorCookieHeader(req: NextRequest, token: string, value: string | null): string {
  const secure = ownOrigin(req).startsWith("https:") ? "; Secure" : "";
  const life = value === null ? "Max-Age=0" : `Max-Age=${VISITOR_COOKIE_MAX_AGE}`;
  return `${VISITOR_COOKIE}=${value ?? ""}; Path=/s/${token}; ${life}; HttpOnly; SameSite=Lax${secure}`;
}

export type LinkContext = { token: string; share: PublicShare; visitor: VisitorRecord | null };

/** The link this request is for and who is writing, or the refusal to send back. */
export async function linkContext(req: NextRequest, rawToken: string, options: { write: boolean }): Promise<LinkContext | Response> {
  if (options.write && !fromThisPage(req)) return fail("This request did not come from the link's page.", 403, "foreignOrigin");
  const token = shareTokenOf(rawToken);
  const share = token ? await findPublicShare(token) : null;
  if (!token || !share) return fail("This link is not open.", 404, "notOpen");
  return { token, share, visitor: await visitorOfCookie(token, visitorCookieOf(req)) };
}

// ---- how much one visitor may do in an hour ---------------------------------------

const HOUR = 60 * 60_000;
const windows = new Map<string, number[]>();

/** Count one more of `kind` for `who`; false when that would pass `limit` in the last hour. */
export function withinLimit(kind: string, who: string, limit: number, now = Date.now()): boolean {
  const key = `${kind}:${who}`;
  const recent = (windows.get(key) ?? []).filter((at) => now - at < HOUR);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return false;
  }
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 50_000) {
    for (const [name, times] of windows) if (!times.some((at) => now - at < HOUR)) windows.delete(name);
  }
  return true;
}
