import { getCompanyProjectsConfig } from "@/lib/company-projects/config";
import type { CompanyConversation, CompanyConversationSummary, CompanyProject } from "@/lib/company-projects/types";

/**
 * The calls this workspace makes about the projects its company opened to it.
 * Server-only: the token never leaves the workspace's own process.
 */
export class CompanyProjectsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CALL_TIMEOUT_MS = 15_000;

async function call(method: "GET" | "POST", route: string, init: { body?: unknown; stream?: boolean; signal?: AbortSignal; allowEmpty?: boolean } = {}): Promise<Response> {
  const config = getCompanyProjectsConfig();
  if (!config) throw new CompanyProjectsError("Company projects are not set up in this workspace.", 503, "notConfigured");
  let response: Response;
  try {
    response = await fetch(`${config.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: init.stream ? "text/event-stream" : "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // An answer can take minutes; only the asking is bounded by the caller.
      signal: init.stream ? init.signal : AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new CompanyProjectsError("The company's service did not answer. Try again in a minute.", 503, "unreachable");
  }
  if (init.allowEmpty && response.status === 204) return response;
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    throw new CompanyProjectsError(
      typeof data?.error === "string" && data.error ? data.error : `The company's service answered ${response.status}.`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return response;
}

const idPath = (id: string) => `/${encodeURIComponent(id)}`;

export async function fetchCompanyProjects(): Promise<CompanyProject[]> {
  const data = (await (await call("GET", "")).json()) as { projects?: CompanyProject[] };
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function fetchCompanyConversations(projectId: string): Promise<CompanyConversationSummary[]> {
  const data = (await (await call("GET", `${idPath(projectId)}/chats`)).json()) as { chats?: CompanyConversationSummary[] };
  return Array.isArray(data.chats) ? data.chats : [];
}

/** One conversation whole, as the chat draws it, and whether a turn is working in it now. */
export async function fetchCompanyConversation(projectId: string, conversationId: string): Promise<CompanyConversation> {
  const data = (await (await call("GET", `${idPath(projectId)}/chats${idPath(conversationId)}?full=1`)).json()) as { chat: CompanyConversation };
  return data.chat;
}

/** Ask, and get the answer back as the workspace chat's own stream (server-sent events). */
export async function askCompanyProject(projectId: string, input: { message: string; conversation?: string }, signal?: AbortSignal): Promise<Response> {
  return await call("POST", `${idPath(projectId)}/message`, { body: { ...input, format: "ui" }, stream: true, signal });
}

/** The turn working in a conversation now, from its start; 204 when there is none. */
export async function streamCompanyConversation(projectId: string, conversationId: string, signal?: AbortSignal): Promise<Response> {
  return await call("GET", `${idPath(projectId)}/chats${idPath(conversationId)}/stream`, { stream: true, signal, allowEmpty: true });
}

/** Stop the turn in a conversation, or answer the card it put up. */
export async function controlCompanyConversation(
  projectId: string,
  action: "stop" | "answer",
  body: { conversation: string; interactionId?: string; value?: string | boolean | null; cancel?: boolean }
): Promise<Record<string, unknown>> {
  return (await (await call("POST", `${idPath(projectId)}/${action}`, { body })).json()) as Record<string, unknown>;
}
