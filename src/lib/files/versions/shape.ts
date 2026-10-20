/**
 * What a file's history looks like on the wire. Client-safe.
 */

/**
 * Who made a version.
 *
 * - `person`: saved in the editor.
 * - `agent`: written by the agent - its write and edit tools, or a command it ran.
 * - `upload`: put there through the Files panel.
 * - `restore`: an older version brought back by the person (`restoredFrom`).
 * - `outside`: changed with nobody here watching - a command in the terminal,
 *   the sync with a computer, another program writing into the folder.
 * - `earlier`: what the file held when its history began, before the first
 *   change anybody here made to it.
 */
export type VersionAuthorKind = "person" | "agent" | "upload" | "restore" | "outside" | "earlier";

export interface VersionAuthor {
  kind: VersionAuthorKind;
  /** The chat whose agent made it. */
  chat?: string;
  /** The turn, so that a turn's several writes to one file make one version. */
  run?: string;
  /** Made by a helper the agent started, or by a scheduled task, rather than by the chat's own turn. */
  helper?: boolean;
  /** For `restore`: the number of the version brought back. */
  restoredFrom?: number;
}

export interface VersionInfo {
  /**
   * Counted per file from 1, and never reused while the file's history lasts,
   * so "version 7" stays version 7. A history deleted and begun again starts
   * from 1 once more.
   */
  n: number;
  /** When the version was seen here: what the retention and the order go by. */
  at: string;
  /** For a state found rather than made here (`earlier`, `outside`): the file's own modification time. */
  fileTime?: string;
  size: number;
  by: VersionAuthor;
  /** The file was deleted here: this version holds nothing. */
  deleted?: boolean;
  /** Lines put in and taken out against the version before it, where that was worked out. */
  added?: number;
  removed?: number;
  /** The chat's title, for an agent's version, while the chat still exists. */
  chatTitle?: string;
}

export interface FileHistoryView {
  /** History is kept at all: off when the workspace or the deployment turned it off. */
  enabled: boolean;
  /** The file is a kind that gets a history. */
  versioned: boolean;
  /** How two of its versions are compared. */
  comparison: "text" | "extracted" | "none";
  /** Newest first. */
  versions: VersionInfo[];
  /** Bytes this file's history takes. */
  bytes: number;
  retention: VersionRetention;
}

export interface VersionRetention {
  /** Every version is kept this long after it was replaced. */
  keepDays: number;
  /** Then one a day, until this many days. */
  dailyDays: number;
  maxPerFile: number;
}

export interface VersionTextView {
  n: number;
  /** `text` is the file itself; `extracted` the text read out of a document; `none` cannot be shown. */
  kind: "text" | "extracted" | "none";
  text: string;
  /** Cut at the limit of what is shown. */
  truncated?: boolean;
  deleted?: boolean;
}

export interface VersionUsageView {
  /** Off by the deployment: nothing here can turn it on. */
  available: boolean;
  /** The workspace's own switch. */
  enabled: boolean;
  bytes: number;
  files: number;
  versions: number;
  /** The most the history may take before the oldest versions go. */
  capBytes: number;
  retention: VersionRetention;
}
