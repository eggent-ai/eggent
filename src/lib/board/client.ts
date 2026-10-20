import type { BoardCard, BoardSnapshot, BoardSummary } from "@/lib/board/types";
import type { ChatHome } from "@/lib/remote/types";

/**
 * The board page's side of the board's routes. Every write is JSON - the
 * routes refuse anything else - and a refusal comes back as the sentence the
 * route wrote for it, in the workspace's language.
 */

export class BoardRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BoardRequestError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new BoardRequestError(data.error || `HTTP ${response.status}`, response.status);
  return data as T;
}

function post<T>(url: string, body: Record<string, unknown> = {}): Promise<T> {
  return request<T>(url, { method: "POST", body: JSON.stringify(body) });
}

export function fetchBoard(options: { archived?: boolean } = {}): Promise<BoardSnapshot> {
  return request<BoardSnapshot>(`/api/board${options.archived ? "?archived=1" : ""}`);
}

export function fetchBoardSummary(): Promise<BoardSummary> {
  return request<BoardSummary>("/api/board/summary");
}

export function fetchCard(id: string): Promise<{ card: BoardCard }> {
  return request<{ card: BoardCard }>(`/api/board/cards/${encodeURIComponent(id)}`);
}

export interface NewCard {
  title: string;
  body: string;
  projectId: string | null;
  after: string[];
  review: boolean;
  /** Where it runs, in a pair; null for the default. */
  home: ChatHome | null;
  start: boolean;
}

export function createCard(card: NewCard): Promise<{ card: BoardCard }> {
  return post("/api/board/cards", { ...card });
}

export function editCard(
  id: string,
  edits: Partial<{ title: string; body: string; projectId: string | null; after: string[]; review: boolean; home: ChatHome | null }>
): Promise<{ card: BoardCard }> {
  return request(`/api/board/cards/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(edits) });
}

export type MoveTo = "inbox" | "queued" | "done" | "archived" | "unarchived";

export function moveCard(id: string, to: MoveTo, position?: number): Promise<{ card: BoardCard }> {
  return request(`/api/board/cards/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ move: { to, ...(position !== undefined ? { position } : {}) } }),
  });
}

export function answerCard(id: string, text: string): Promise<{ card: BoardCard }> {
  return post(`/api/board/cards/${encodeURIComponent(id)}/answer`, { text });
}

export function stopCard(id: string): Promise<{ card: BoardCard }> {
  return post(`/api/board/cards/${encodeURIComponent(id)}/stop`);
}

export function deleteCard(id: string): Promise<{ success: boolean }> {
  return request(`/api/board/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function startInbox(projectId?: string): Promise<{ started: number }> {
  return post("/api/board/start-all", projectId ? { projectId } : {});
}

export function resumeBoard(): Promise<{ success: boolean }> {
  return post("/api/board/resume");
}
