import { relayBaseUrl, relayHeadersTimeoutMs, relayToken } from "@/lib/remote/config";
import {
  RemoteError,
  type ChatHome,
  type RemoteDevice,
  type RemoteFailureCode,
} from "@/lib/remote/types";

/**
 * Reaching the other side.
 *
 * A workspace cannot open a connection to a computer, and a computer sits
 * behind a router: both talk to the control plane, which already knows them
 * both and which the computer keeps a connection open to. A request for the
 * other side goes there and comes back as that side's own response, streamed.
 *
 * The control plane answers for itself only when it could not deliver the
 * request, and says so in a header, so that a failure of the road is never
 * mistaken for the other side's own refusal - both are JSON with a status.
 */

export const RELAY_ERROR_HEADER = "x-eggent-relay-error";

const RELAY_CODES = new Set<RemoteFailureCode>([
  "disabled",
  "offline",
  "denied",
  "not-ready",
  "engine",
  "not-synced",
  "busy",
  "not-running",
  "moved",
  "failed",
  "timeout",
]);

function asCode(value: unknown): RemoteFailureCode | null {
  return typeof value === "string" && RELAY_CODES.has(value as RemoteFailureCode) ? (value as RemoteFailureCode) : null;
}

export interface RelayRequest {
  method: string;
  /** The path on the other side, starting with a slash: an `/api/...` address of the app. */
  path: string;
  headers?: Record<string, string>;
  /** A text body; the requests that are handed over are all JSON. */
  body?: string;
  signal?: AbortSignal;
}

function endpoint(pathname: string): { url: string; token: string } {
  const base = relayBaseUrl();
  const token = relayToken();
  if (!base || !token) throw new RemoteError("disabled", "This install cannot hand chats to another side.");
  return { url: `${base}${pathname}`, token };
}

/**
 * Send a request to the other side and return its response, headers first.
 * Throws a `RemoteError` when the road failed; a refusal from the other side
 * is an ordinary response with a status, for the caller to read.
 */
export async function relayRequest(target: ChatHome, init: RelayRequest): Promise<Response> {
  const { url, token } = endpoint("/request");

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("relay did not answer in time"));
  }, relayHeadersTimeoutMs());

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        target,
        method: init.method,
        path: init.path,
        headers: init.headers ?? {},
        body: init.body ?? null,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (timedOut) throw new RemoteError("timeout", "The other side did not answer in time.", { home: target });
    throw new RemoteError("offline", `The connection to the other side failed: ${error instanceof Error ? error.message : String(error)}`, { home: target });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", forwardAbort);
  }

  // From here the caller owns the stream; its own signal still cancels it.
  if (init.signal) {
    if (init.signal.aborted) void response.body?.cancel().catch(() => undefined);
    else init.signal.addEventListener("abort", () => void response.body?.cancel().catch(() => undefined), { once: true });
  }

  const relayError = response.headers.get(RELAY_ERROR_HEADER);
  if (relayError) {
    const detail = await readErrorBody(response);
    // The road's own failure is told by its code; the status that goes to the screen follows the code, not the road.
    throw new RemoteError(asCode(relayError) ?? "failed", detail.message || "The other side could not be reached.", { home: target });
  }
  return response;
}

async function readErrorBody(response: Response): Promise<{ message: string; code: RemoteFailureCode | null; home?: ChatHome }> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
      const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : "";
      return { message: message || text.slice(0, 300), code: asCode(parsed.code) };
    } catch {
      return { message: text.slice(0, 300), code: null };
    }
  } catch {
    return { message: "", code: null };
  }
}

/** A response that was not a success, as the error it stands for. */
export async function errorFromResponse(response: Response, home?: ChatHome): Promise<RemoteError> {
  const detail = await readErrorBody(response);
  const code = detail.code ?? (response.status === 403 ? "denied" : response.status === 409 ? "busy" : "failed");
  return new RemoteError(code, detail.message || `The other side answered ${response.status}.`, { status: response.status, home });
}

/** A small request whose answer is JSON; anything but a success is thrown. */
export async function relayJson<T>(target: ChatHome, init: RelayRequest): Promise<T> {
  const response = await relayRequest(target, init);
  if (!response.ok) throw await errorFromResponse(response, target);
  return (await response.json()) as T;
}

function cleanDevice(value: unknown): RemoteDevice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const node = typeof record.node === "string" ? record.node : "";
  if (!node.startsWith("device:")) return null;
  return {
    node: node as ChatHome,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 80) : "Computer",
    online: record.online === true,
    accept: record.accept === "ask" || record.accept === "always" ? record.accept : null,
    historyShared: record.historyShared === true,
    lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : null,
  };
}

/** The computers paired with this workspace, with whether each can take a chat right now. */
export async function listDevices(signal?: AbortSignal): Promise<RemoteDevice[]> {
  const { url, token } = endpoint("/devices");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok) throw new RemoteError("failed", `The control plane answered ${response.status}.`, { status: response.status });
    const payload = (await response.json()) as { devices?: unknown };
    return Array.isArray(payload.devices)
      ? payload.devices.map(cleanDevice).filter((device): device is RemoteDevice => device !== null)
      : [];
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError("offline", `The control plane could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
