/**
 * What shared files look like on the wire, as the service answers them. Client-safe.
 *
 * A shared file stays in its owner's workspace; the people it is shared with
 * see it as it is now, comment on it, and - with "edit" - change it there.
 */

export type ShareRole = "view" | "comment" | "edit";
export const SHARE_ROLES: ShareRole[] = ["view", "comment", "edit"];

export interface SharePerson {
  id: string;
  name: string;
  role: ShareRole | "owner";
  /** Not in the company any more. */
  gone: boolean;
}

export interface ShareView {
  id: string;
  fileName: string;
  /** The file's path under the owner's projects folder; only its owner is told. */
  fileKey: string | null;
  owner: SharePerson;
  mine: boolean;
  myRole: ShareRole | "owner";
  people: SharePerson[];
  /** Comments nobody has marked resolved. */
  unresolved: number;
  /** Something happened since this person last opened it: a change, or somebody else's comment. */
  unseen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShareFileState {
  exists: boolean;
  sha256: string | null;
  size: number;
  mime: string;
  modifiedAt: string | null;
}

export interface ShareCommentAnchor {
  startLine?: number;
  endLine?: number;
  /** What the piece is, as a page names its block: "h1", "section.terms". */
  label?: string;
}

export interface ShareComment {
  id: string;
  author: { id: string; name: string; gone: boolean };
  viaAgent: boolean;
  mine: boolean;
  body: string;
  /** The piece of the file the comment is about, as it read when written. */
  quote: string | null;
  anchor: ShareCommentAnchor | null;
  /** The thread this is a reply in. */
  replyTo: string | null;
  resolved: { at: string; by: string } | null;
  createdAt: string;
}

export interface SharePeopleAnswer {
  me: { id: string; name: string; role: "owner" | "member" | null; gone: boolean };
  company: { id: string; name: string };
  people: Array<{ id: string; name: string; role: "owner" | "member" | null; gone: boolean; about: string | null }>;
}

export interface ShareCounts {
  /** Files shared with this person. */
  withMe: number;
  /** Of them, with something new since they last opened it. */
  unseen: number;
  /** Comments nobody resolved yet on this person's own shared files. */
  openOnMine: number;
}

export type SharesSummary = ({ enabled: true } & ShareCounts) | { enabled: false };

/** One of this workspace's files and who it is shared with, for the file's own screen. */
export interface FileShareStatus {
  enabled: boolean;
  share: ShareView | null;
  current: { exists: boolean; tooLarge: boolean; sensitive: boolean };
  maxBytes: number;
}

/** A change one of the people made through a share, as the owner's history can name it. */
export interface ShareEdit {
  sha256: string;
  by: string;
  at: string;
}

export const SHARE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Most a shared file can be when it is changed from the screen of somebody it is shared with. */
export const SHARE_MAX_WRITE_BYTES = 5 * 1024 * 1024;
export const SHARE_MAX_COMMENT_CHARS = 4000;
export const SHARE_MAX_QUOTE_CHARS = 2000;
export const SHARE_MAX_PEOPLE = 50;

export function canComment(role: ShareView["myRole"]): boolean {
  return role !== "view";
}

export function canEdit(role: ShareView["myRole"]): boolean {
  return role === "edit";
}
