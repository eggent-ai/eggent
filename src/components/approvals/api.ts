"use client";

import type { Approval, ApprovalBox, ApprovalCounts, ApprovalPeopleAnswer, FileApprovalStatus } from "@/lib/approvals/types";

/** What the approvals routes answer, read by the screens. A refusal carries the service's own sentence. */

export class ApprovalsRequestError extends Error {
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
    throw new ApprovalsRequestError(
      typeof data?.error === "string" && data.error ? data.error : `HTTP ${response.status}`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return data as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }).then((response) => readJson<T>(response));
}

const idUrl = (id: string) => `/api/approvals/${encodeURIComponent(id)}`;

export const approvalsApi = {
  list: (box: ApprovalBox) => fetch(`/api/approvals?box=${box}`, { cache: "no-store" }).then((response) => readJson<{ approvals: Approval[]; counts: ApprovalCounts }>(response)),
  people: () => fetch("/api/approvals/people", { cache: "no-store" }).then((response) => readJson<ApprovalPeopleAnswer>(response)),
  detail: (id: string) => fetch(idUrl(id), { cache: "no-store" }).then((response) => readJson<{ approval: Approval }>(response)).then((data) => data.approval),
  file: (project: string, path: string) =>
    fetch(`/api/approvals/file?${new URLSearchParams({ project, path }).toString()}`, { cache: "no-store" }).then((response) => readJson<FileApprovalStatus>(response)),
  send: (input: { project: string; path: string; approvers: string[]; note?: string }) => post<{ approval: Approval }>("/api/approvals/send", input).then((data) => data.approval),
  decide: (id: string, input: { round: number; decision: "approve" | "reject"; comment?: string }) => post<{ approval: Approval }>(`${idUrl(id)}/decide`, input).then((data) => data.approval),
  cancel: (id: string) => post<{ approval: Approval }>(`${idUrl(id)}/cancel`, {}).then((data) => data.approval),
  text: (id: string, round: number) =>
    fetch(`${idUrl(id)}/rounds/${round}/text`, { cache: "no-store" }).then((response) => readJson<{ round: number; kind: "text" | "extracted" | "none"; text: string; truncated?: boolean }>(response)),
  fileUrl: (id: string, round: number, inline = false) => `${idUrl(id)}/rounds/${round}/file${inline ? "?inline=1" : ""}`,
};

/** Kinds a browser shows sandboxed rather than saving: the "Open" button is offered for these. */
export function opensInBrowser(mime: string): boolean {
  return ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown", "text/csv"].includes(mime);
}
