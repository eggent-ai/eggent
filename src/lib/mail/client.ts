import { getMailConfig } from "@/lib/mail/config";
import type { MailContactsAnswer, MailMessage, MailThreadAnswer } from "@/lib/mail/types";

/**
 * The calls this workspace makes to its messages service. Server-only: the
 * token never leaves the workspace's own process.
 *
 * A refusal carries the service's own sentence, already in this workspace's
 * language, and a code a screen or the agent can tell apart.
 */
export class MailServiceError extends Error {
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
  const config = getMailConfig();
  if (!config) throw new MailServiceError("Messages are not set up in this workspace.", 503, "notConfigured");
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
    throw new MailServiceError("The messages service did not answer. Try again in a minute.", 503, "unreachable");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    throw new MailServiceError(
      typeof data?.error === "string" && data.error ? data.error : `The messages service answered ${response.status}.`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return response;
}

async function json<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return (await (await call(method, route, body, timeoutMs)).json()) as T;
}

export interface MailFileUpload {
  name: string;
  mime?: string;
  data: Buffer;
}

export interface PendingMailAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  messageId: number;
  contactId: string;
  contactName: string;
  fromMe: boolean;
  createdAt: string;
}

export async function fetchMailContacts(): Promise<Extract<MailContactsAnswer, { enabled: true }>> {
  const data = await json<Omit<Extract<MailContactsAnswer, { enabled: true }>, "enabled">>("GET", "/contacts");
  return { enabled: true, ...data };
}

export async function fetchMailThread(contactId: string, options: { before?: number; limit?: number } = {}): Promise<MailThreadAnswer> {
  const params = new URLSearchParams({ with: contactId });
  if (options.before) params.set("before", String(options.before));
  if (options.limit) params.set("limit", String(options.limit));
  return await json<MailThreadAnswer>("GET", `/thread?${params.toString()}`);
}

export async function fetchMailMessage(messageId: number): Promise<{ message: MailMessage; contact: MailThreadAnswer["contact"] }> {
  return await json("GET", `/messages/${encodeURIComponent(String(Math.floor(messageId)))}`);
}

export async function fetchMailInbox(limit = 30): Promise<{ unreadTotal: number; messages: Array<MailMessage & { contact: { id: string; name: string } }> }> {
  return await json("GET", `/inbox?limit=${encodeURIComponent(String(limit))}`);
}

export async function sendMailMessage(input: {
  to: string;
  text: string;
  replyTo?: number | null;
  author: "person" | "agent";
  files?: MailFileUpload[];
}): Promise<MailMessage> {
  const data = await json<{ message: MailMessage }>(
    "POST",
    "/send",
    {
      to: input.to,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      author: input.author,
      files: (input.files || []).map((file) => ({ name: file.name, mime: file.mime, data: file.data.toString("base64") })),
    },
    SEND_TIMEOUT_MS
  );
  return data.message;
}

export async function markMailThreadRead(contactId: string, upTo?: number): Promise<{ readUpTo: number }> {
  return await json("POST", "/read", { with: contactId, ...(upTo ? { upTo } : {}) });
}

export async function fetchPendingMailAttachments(): Promise<PendingMailAttachment[]> {
  const data = await json<{ attachments: PendingMailAttachment[] }>("GET", "/attachments/pending");
  return Array.isArray(data.attachments) ? data.attachments : [];
}

export async function downloadMailAttachment(attachmentId: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const response = await call("GET", `/attachments/${encodeURIComponent(attachmentId)}`, undefined, SEND_TIMEOUT_MS);
  const name = decodeURIComponent(response.headers.get("x-mail-file-name") || "") || "file";
  const mime = response.headers.get("x-mail-file-type") || "application/octet-stream";
  return { name, mime, data: Buffer.from(await response.arrayBuffer()) };
}

export async function confirmMailAttachmentCopied(attachmentId: string): Promise<void> {
  await call("POST", `/attachments/${encodeURIComponent(attachmentId)}/copied`);
}
