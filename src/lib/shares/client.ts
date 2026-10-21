import { getSharesConfig } from "@/lib/shares/config";
import type { ShareComment, ShareCommentAnchor, ShareCounts, ShareEdit, ShareFileState, SharePeopleAnswer, ShareRole, ShareView } from "@/lib/shares/types";

/**
 * The calls this workspace makes to its sharing service. Server-only: the
 * token never leaves the workspace's own process.
 *
 * A refusal carries the service's own sentence, already in this workspace's
 * language, and a code a screen or the agent can tell apart.
 */
export class SharesServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CALL_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 90_000;

async function call(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<Response> {
  const config = getSharesConfig();
  if (!config) throw new SharesServiceError("Sharing is not set up in this workspace.", 503, "notConfigured");
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
    throw new SharesServiceError("The sharing service did not answer. Try again in a minute.", 503, "unreachable");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    throw new SharesServiceError(
      typeof data?.error === "string" && data.error ? data.error : `The sharing service answered ${response.status}.`,
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

function headerName(response: Response): string {
  const raw = response.headers.get("x-share-file-name") || "file";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function fetchSharePeople(): Promise<SharePeopleAnswer> {
  return await json<SharePeopleAnswer>("GET", "/people");
}

export async function fetchShareCounts(): Promise<ShareCounts> {
  return await json<ShareCounts>("GET", "/counts");
}

export async function fetchShares(): Promise<{ mine: ShareView[]; withMe: ShareView[] }> {
  return await json("GET", "/");
}

/** The share of one of this workspace's own files, by its path under the projects folder. */
export async function fetchShareForKey(key: string): Promise<ShareView | null> {
  return (await json<{ share: ShareView | null }>("GET", `/?${new URLSearchParams({ key }).toString()}`)).share;
}

/** Shares one of this workspace's files; the list of people given is the whole list. */
export async function shareFileWith(input: { key: string; fileName: string; people: Array<{ id: string; role: ShareRole }> }): Promise<ShareView> {
  return (await json<{ share: ShareView }>("POST", "/share", input)).share;
}

export async function stopSharingFile(id: string): Promise<void> {
  await json("POST", `${idPath(id)}/stop`, {});
}

export async function fetchShare(id: string): Promise<{ share: ShareView; file: ShareFileState }> {
  return await json("GET", idPath(id));
}

/** A shared file as it is now in its owner's workspace. */
export async function fetchSharedFile(id: string): Promise<{ name: string; mime: string; data: Buffer; sha256: string }> {
  const response = await call("GET", `${idPath(id)}/content`, undefined, FILE_TIMEOUT_MS);
  const data = Buffer.from(await response.arrayBuffer());
  return {
    name: headerName(response),
    mime: response.headers.get("x-share-file-type") || "application/octet-stream",
    data,
    sha256: response.headers.get("x-share-file-sha256") || "",
  };
}

/** A file beside a shared page: a picture, a style, a script. */
export async function fetchSharedAsset(id: string, relative: string): Promise<{ name: string; mime: string; data: Buffer }> {
  const response = await call("GET", `${idPath(id)}/asset?${new URLSearchParams({ path: relative }).toString()}`, undefined, FILE_TIMEOUT_MS);
  return { name: headerName(response), mime: response.headers.get("x-share-file-type") || "application/octet-stream", data: Buffer.from(await response.arrayBuffer()) };
}

/** Writes a shared file in its owner's workspace - onto the version it was read at, or not at all. */
export async function writeSharedFile(id: string, input: { baseSha: string; data: Buffer }): Promise<{ sha256: string; size: number }> {
  return await json("POST", `${idPath(id)}/content`, { baseSha: input.baseSha, data: input.data.toString("base64") }, FILE_TIMEOUT_MS);
}

export async function markShareSeen(id: string): Promise<void> {
  await json("POST", `${idPath(id)}/seen`, {});
}

export async function fetchShareComments(id: string): Promise<ShareComment[]> {
  return (await json<{ comments: ShareComment[] }>("GET", `${idPath(id)}/comments`)).comments;
}

export async function addShareComment(id: string, input: { body: string; quote?: string | null; anchor?: ShareCommentAnchor | null; replyTo?: string | null; author: "person" | "agent" }): Promise<ShareComment> {
  return (await json<{ comment: ShareComment }>("POST", `${idPath(id)}/comments`, {
    body: input.body,
    ...(input.quote ? { quote: input.quote } : {}),
    ...(input.anchor ? { anchor: input.anchor } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    author: input.author,
  })).comment;
}

export async function resolveShareComment(id: string, commentId: string, resolved: boolean): Promise<ShareComment> {
  return (await json<{ comment: ShareComment }>("POST", `${idPath(id)}/comments/${encodeURIComponent(commentId)}/resolve`, { resolved })).comment;
}

export async function deleteShareComment(id: string, commentId: string): Promise<void> {
  await json("POST", `${idPath(id)}/comments/${encodeURIComponent(commentId)}/delete`, {});
}

/** The changes the people a file is shared with made to it, newest first - for its history. */
export async function fetchShareEdits(key: string, timeoutMs?: number): Promise<ShareEdit[]> {
  return (await json<{ edits: ShareEdit[] }>("GET", `/edits?${new URLSearchParams({ key }).toString()}`, undefined, timeoutMs)).edits;
}

/** One of this workspace's shared files changed here: the service looks at it and tells its people. */
export async function reportSharedFileChanged(key: string): Promise<{ changed: boolean }> {
  return await json("POST", "/touch", { key });
}
