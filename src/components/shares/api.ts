"use client";

import type { FileShareStatus, ShareComment, ShareCommentAnchor, ShareFileState, SharePeopleAnswer, ShareRole, ShareView } from "@/lib/shares/types";

/** What the sharing routes answer, read by the screens. A refusal carries the service's own sentence. */

export class SharesRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (!response.ok) {
    throw new SharesRequestError(
      typeof data?.error === "string" && data.error ? data.error : `HTTP ${response.status}`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return data as T;
}

function get<T>(url: string): Promise<T> {
  return fetch(url, { cache: "no-store" }).then((response) => readJson<T>(response));
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }).then((response) => readJson<T>(response));
}

const idUrl = (id: string) => `/api/shares/${encodeURIComponent(id)}`;

export type SharedText =
  | { kind: "text"; text: string; name: string; mime: string; size: number; sha256: string }
  | { kind: "extracted"; text: string; truncated: boolean; name: string; mime: string; size: number; sha256: string }
  | { kind: "image" | "binary"; name: string; mime: string; size: number; sha256: string };

export const sharesApi = {
  list: () => get<{ mine: ShareView[]; withMe: ShareView[] }>("/api/shares"),
  people: () => get<SharePeopleAnswer>("/api/shares/people"),
  file: (project: string, path: string) => get<FileShareStatus>(`/api/shares/file?${new URLSearchParams({ project, path }).toString()}`),
  share: (input: { project: string; path: string; people: Array<{ id: string; role: ShareRole }> }) => post<{ share: ShareView }>("/api/shares/share", input).then((data) => data.share),
  stop: (id: string) => post<{ ok: true }>(`${idUrl(id)}/stop`, {}),
  detail: (id: string) => get<{ share: ShareView; file: ShareFileState }>(idUrl(id)),
  seen: (id: string) => post<{ ok: true }>(`${idUrl(id)}/seen`, {}),
  text: (id: string) => get<SharedText>(`${idUrl(id)}/text`),
  save: (id: string, input: { baseSha: string; text: string }) => post<{ sha256: string; size: number }>(`${idUrl(id)}/content`, input),
  comments: (id: string) => get<{ comments: ShareComment[] }>(`${idUrl(id)}/comments`).then((data) => data.comments),
  comment: (id: string, input: { body: string; quote?: string | null; anchor?: ShareCommentAnchor | null; replyTo?: string | null }) =>
    post<{ comment: ShareComment }>(`${idUrl(id)}/comments`, input).then((data) => data.comment),
  resolve: (id: string, commentId: string, resolved: boolean) =>
    post<{ comment: ShareComment }>(`${idUrl(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { resolved }).then((data) => data.comment),
  remove: (id: string, commentId: string) => post<{ ok: true }>(`${idUrl(id)}/comments/${encodeURIComponent(commentId)}/delete`, {}),
  contentUrl: (id: string, inline = false) => `${idUrl(id)}/content${inline ? "?inline=1" : ""}`,
  printUrl: (id: string) => `${idUrl(id)}/print`,
};

export function sharedPath(id: string): string {
  return `/dashboard/shared/${encodeURIComponent(id)}`;
}
