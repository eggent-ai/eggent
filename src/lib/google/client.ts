import { getGoogleConfig } from "@/lib/google/config";
import type { GoogleStatus } from "@/lib/google/types";

/**
 * The calls this workspace makes to its Google service. Server-only: the
 * token never leaves the workspace's own process.
 *
 * A refusal carries the service's own sentence and a code the agent or a
 * screen can tell apart; one that needs the person to connect carries the
 * address they connect at.
 */
export class GoogleServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly connectUrl?: string;
  constructor(message: string, status: number, code: string, connectUrl?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.connectUrl = connectUrl;
  }
}

const CALL_TIMEOUT_MS = 30_000;

async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const config = getGoogleConfig();
  if (!config) throw new GoogleServiceError("Google is not set up in this workspace.", 503, "notConfigured");
  let response: Response;
  try {
    response = await fetch(`${config.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new GoogleServiceError("The Google service did not answer. Try again in a minute.", 503, "unreachable");
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new GoogleServiceError(
      typeof data?.error === "string" && data.error ? data.error : `The Google service answered ${response.status}.`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed",
      typeof data?.connectUrl === "string" ? data.connectUrl : undefined
    );
  }
  return (data ?? {}) as T;
}

export async function fetchGoogleStatus(): Promise<GoogleStatus> {
  return await call<GoogleStatus>("GET", "/status");
}

export async function disconnectGoogle(): Promise<void> {
  await call("POST", "/disconnect", {});
}

/** One of the actions the service allows, with its parameters; the service checks both. */
export async function callGoogleAction<T = Record<string, unknown>>(action: string, params: Record<string, unknown>): Promise<T> {
  return await call<T>("POST", `/${encodeURIComponent(action)}`, params);
}
