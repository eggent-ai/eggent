/**
 * Who may reach a shell.
 *
 * These routes start processes, so they check for themselves instead of
 * trusting the middleware in front of them. The middleware has a bypass for any
 * path whose last segment contains a dot (open issue 2), and a rule that lives
 * in one place and has a known hole is not enough in front of a shell. Each
 * handler therefore requires a valid session cookie of its own.
 *
 * A session alone is not enough either. Workspaces share a registrable domain,
 * so a page on one workspace is the *same site* as the next one, and a
 * `SameSite=Lax` cookie goes along with its requests. A cross-origin POST with a
 * `text/plain` body is a "simple" request that needs no preflight, so a handler
 * that parses JSON out of whatever it is given would run a command for a page
 * the person merely visited. Writes therefore have to be `application/json`
 * (which a foreign page cannot send without a preflight we never answer) and
 * must not carry an Origin or Sec-Fetch-Site that says they came from
 * elsewhere.
 */
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { TERMINAL_JOB_ID_PATTERN } from "@/lib/terminal/protocol";
import { getTerminalRegistry, type TerminalRegistry } from "@/lib/terminal/registry";

/** `json` is a body of a kind the route does not read, whatever kind that is. */
export type GuardFailure = "unauthorized" | "origin" | "json";

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function requestComesFromThisSite(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .flatMap((value) => (value ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);
  return hosts.includes(originHost);
}

/**
 * Null when the request may go on, otherwise the failure to name in the answer.
 * `write` is for anything that changes a process: starting, typing, stopping.
 * A write is JSON unless the route says it takes a file: an upload is a
 * `multipart/form-data` form, which a foreign page *can* send without a
 * preflight, so for those the same-site check above is the whole defence and the
 * body type only keeps a route from parsing what it was not meant to.
 */
export async function checkTerminalRequest(
  req: NextRequest,
  options: { write: boolean; body?: "json" | "multipart" }
): Promise<GuardFailure | null> {
  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = cookie ? await verifySessionToken(cookie) : null;
  if (!session) return "unauthorized";
  // Until the default login is replaced the workspace is not yet anybody's.
  if (session.mustChangeCredentials) return "unauthorized";
  if (!requestComesFromThisSite(req)) return "origin";
  if (options.write) {
    const type = req.headers.get("content-type") || "";
    const expected = options.body === "multipart" ? /^multipart\/form-data\b/i : /^application\/json\b/i;
    if (!expected.test(type)) return "json";
  }
  return null;
}

export function guardStatus(failure: GuardFailure): number {
  if (failure === "unauthorized") return 401;
  if (failure === "origin") return 403;
  return 415;
}

export interface JobRequestContext {
  id: string;
  registry: TerminalRegistry;
}

/** Everything a request for one job needs settled before it does anything. */
export async function authorizeJobRequest(
  req: NextRequest,
  params: Promise<{ id: string }>,
  options: { write: boolean }
): Promise<{ context: JobRequestContext } | { failure: GuardFailure | "not-found" }> {
  const failure = await checkTerminalRequest(req, options);
  if (failure) return { failure };
  const { id } = await params;
  const registry = getTerminalRegistry();
  if (!TERMINAL_JOB_ID_PATTERN.test(id) || !registry.has(id)) return { failure: "not-found" };
  return { context: { id, registry } };
}
