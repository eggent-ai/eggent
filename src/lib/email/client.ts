import { getEmailConfig } from "@/lib/email/config";
import type { EmailMessage, EmailSendAnswer, EmailStatus, EmailSummary } from "@/lib/email/types";

/**
 * The calls this workspace makes to its email service. Server-only: the token
 * never leaves the workspace's own process. A refusal carries the service's
 * own sentence for the agent and a code that tells refusals apart.
 */
export class EmailServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CALL_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 90_000;

async function call(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<Response> {
  const config = getEmailConfig();
  if (config?.mode !== "service") throw new EmailServiceError("This workspace has no email service.", 503, "notConfigured");
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
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new EmailServiceError("The email service did not answer. Try again in a minute.", 503, "unreachable");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    throw new EmailServiceError(
      typeof data?.error === "string" && data.error ? data.error : `The email service answered ${response.status}.`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return response;
}

async function json<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return (await (await call(method, route, body, timeoutMs)).json()) as T;
}

export async function fetchEmailStatus(): Promise<EmailStatus> {
  return json<EmailStatus>("GET", "/status");
}

export interface OutgoingEmail {
  /** Omitted or empty: the person's own mailbox. */
  to?: string[];
  subject?: string;
  text: string;
  attachments: Array<{ name: string; mime?: string; data: Buffer }>;
  /** The id of the letter this answers. */
  replyTo?: number | null;
}

export async function sendEmailThroughService(letter: OutgoingEmail): Promise<EmailSendAnswer> {
  return json<EmailSendAnswer>("POST", "/send", {
    ...(letter.to?.length ? { to: letter.to } : {}),
    ...(letter.subject ? { subject: letter.subject } : {}),
    text: letter.text,
    attachments: letter.attachments.map((file) => ({ name: file.name, ...(file.mime ? { mime: file.mime } : {}), data: file.data.toString("base64") })),
    ...(typeof letter.replyTo === "number" ? { replyTo: letter.replyTo } : {}),
  }, SEND_TIMEOUT_MS);
}

export async function fetchEmailList(options: { folder?: string | null; after?: number | null; unread?: boolean; limit?: number } = {}): Promise<EmailSummary[]> {
  const query = new URLSearchParams();
  if (options.folder) query.set("folder", options.folder);
  if (typeof options.after === "number") query.set("after", String(Math.max(0, Math.floor(options.after))));
  if (options.unread) query.set("unread", "1");
  if (options.limit) query.set("limit", String(Math.max(1, Math.min(100, Math.floor(options.limit)))));
  const answer = await json<{ messages?: EmailSummary[] }>("GET", `/messages${query.size ? `?${query}` : ""}`);
  return Array.isArray(answer.messages) ? answer.messages : [];
}

export async function fetchEmailMessage(id: number): Promise<EmailMessage> {
  const answer = await json<{ message: EmailMessage }>("GET", `/messages/${Math.floor(id)}`);
  return answer.message;
}

export async function markEmailRead(id: number): Promise<void> {
  await call("POST", `/messages/${Math.floor(id)}/read`);
}

export async function downloadEmailAttachment(id: number, n: number): Promise<{ name: string; mime: string; data: Buffer }> {
  const response = await call("GET", `/messages/${Math.floor(id)}/attachments/${Math.floor(n)}`, undefined, SEND_TIMEOUT_MS);
  const name = decodeURIComponent(response.headers.get("x-eggent-file-name") || `attachment-${n + 1}`);
  const mime = response.headers.get("x-eggent-file-type") || "application/octet-stream";
  return { name, mime, data: Buffer.from(await response.arrayBuffer()) };
}
