import { getApprovalsConfig } from "@/lib/approvals/config";
import type { Approval, ApprovalBox, ApprovalCounts, ApprovalPeopleAnswer } from "@/lib/approvals/types";

/**
 * The calls this workspace makes to its approvals service. Server-only: the
 * token never leaves the workspace's own process.
 *
 * A refusal carries the service's own sentence, already in this workspace's
 * language, and a code a screen or the agent can tell apart.
 */
export class ApprovalsServiceError extends Error {
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
  const config = getApprovalsConfig();
  if (!config) throw new ApprovalsServiceError("Approvals are not set up in this workspace.", 503, "notConfigured");
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
    throw new ApprovalsServiceError("The approvals service did not answer. Try again in a minute.", 503, "unreachable");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    throw new ApprovalsServiceError(
      typeof data?.error === "string" && data.error ? data.error : `The approvals service answered ${response.status}.`,
      response.status,
      typeof data?.code === "string" ? data.code : "failed"
    );
  }
  return response;
}

async function json<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return (await (await call(method, route, body, timeoutMs)).json()) as T;
}

function idPath(id: string): string {
  return `/${encodeURIComponent(id)}`;
}

export async function fetchApprovalPeople(): Promise<ApprovalPeopleAnswer> {
  return await json<ApprovalPeopleAnswer>("GET", "/people");
}

export async function fetchApprovalCounts(): Promise<ApprovalCounts> {
  return await json<ApprovalCounts>("GET", "/counts");
}

export async function fetchApprovals(box: ApprovalBox, limit?: number): Promise<{ approvals: Approval[]; counts: ApprovalCounts }> {
  const params = new URLSearchParams({ box });
  if (limit) params.set("limit", String(Math.floor(limit)));
  return await json("GET", `/?${params.toString()}`);
}

/** The open approval of one of this workspace's own files, by its path under the projects folder. */
export async function fetchApprovalForKey(key: string): Promise<Approval | null> {
  const data = await json<{ approvals: Approval[] }>("GET", `/?${new URLSearchParams({ key }).toString()}`);
  return data.approvals[0] ?? null;
}

export async function fetchApproval(id: string): Promise<Approval> {
  return (await json<{ approval: Approval }>("GET", idPath(id))).approval;
}

export async function fetchApprovalFile(id: string, round: number): Promise<{ name: string; mime: string; data: Buffer; sha256: string; versionN: number | null }> {
  const response = await call("GET", `${idPath(id)}/rounds/${encodeURIComponent(String(Math.floor(round)))}/file`, undefined, SEND_TIMEOUT_MS);
  const data = Buffer.from(await response.arrayBuffer());
  const rawName = response.headers.get("x-approval-file-name") || "file";
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // An undecodable name is shown as it came.
  }
  const versionN = Number(response.headers.get("x-approval-version") || 0);
  return {
    name,
    mime: response.headers.get("x-approval-file-type") || "application/octet-stream",
    data,
    sha256: response.headers.get("x-approval-file-sha256") || "",
    versionN: Number.isInteger(versionN) && versionN > 0 ? versionN : null,
  };
}

export async function sendVersionForApproval(input: {
  key: string;
  fileName: string;
  mime?: string;
  data: Buffer;
  versionN: number | null;
  approvers: string[];
  note?: string;
  author: "person" | "agent";
}): Promise<Approval> {
  const data = await json<{ approval: Approval }>(
    "POST",
    "/send",
    {
      key: input.key,
      fileName: input.fileName,
      ...(input.mime ? { mime: input.mime } : {}),
      data: input.data.toString("base64"),
      ...(input.versionN ? { versionN: input.versionN } : {}),
      approvers: input.approvers,
      note: input.note || "",
      author: input.author,
    },
    SEND_TIMEOUT_MS
  );
  return data.approval;
}

export async function decideOnApproval(id: string, input: { round: number; decision: "approve" | "reject"; comment?: string; author: "person" | "agent" }): Promise<Approval> {
  const data = await json<{ approval: Approval }>("POST", `${idPath(id)}/decide`, {
    round: input.round,
    decision: input.decision,
    comment: input.comment || "",
    author: input.author,
  });
  return data.approval;
}

export async function cancelApprovalRequest(id: string): Promise<Approval> {
  return (await json<{ approval: Approval }>("POST", `${idPath(id)}/cancel`, {})).approval;
}

/** The file of an approval's newest round changed here: that round no longer counts. */
export async function reportApprovalOutdated(id: string, report: { round: number; sha: string | null }): Promise<Approval> {
  return (await json<{ approval: Approval }>("POST", `${idPath(id)}/outdated`, { round: report.round, sha: report.sha ?? "" })).approval;
}
