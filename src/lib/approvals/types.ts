/**
 * What approvals look like on the wire, as the service answers them. Client-safe.
 *
 * What is approved is a version of a file, not the file: a round holds the
 * bytes it was sent with, and any change to the file voids it, so the next
 * version starts the chain over from its first person.
 */

export type ApprovalStatus = "active" | "approved" | "rejected" | "outdated" | "cancelled";
export type ApprovalStepState = "pending" | "approved" | "rejected" | "skipped";

export interface ApprovalPerson {
  id: string;
  name: string;
  role: "owner" | "member" | null;
  /** Not in the company any more: shown under the name they had. */
  gone: boolean;
}

export interface ApprovalStep {
  position: number;
  person: ApprovalPerson;
  state: ApprovalStepState;
  /** Whose turn it is now, in a round that is going. */
  current: boolean;
  comment: string | null;
  decidedAt: string | null;
  viaAgent: boolean;
}

export interface ApprovalRound {
  round: number;
  versionN: number | null;
  sha256: string;
  size: number;
  mime: string;
  fileName: string;
  note: string | null;
  sentByAgent: boolean;
  status: ApprovalStatus;
  createdAt: string;
  closedAt: string | null;
  /** The file changed after this round was approved: it was approved, and the approval no longer stands. */
  voidedAt: string | null;
  steps: ApprovalStep[];
}

export interface Approval {
  id: string;
  fileName: string;
  /** Where the file is in its author's workspace (its path under the projects folder); only its author is told. */
  fileKey: string | null;
  author: ApprovalPerson;
  mine: boolean;
  status: ApprovalStatus;
  currentRound: number;
  /** A newer version went to other people after the last round this person was in. */
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
  waitingFor: ApprovalPerson | null;
  myTurn: boolean;
  /** Newest first; the ones this person may see. */
  rounds: ApprovalRound[];
}

export interface ApprovalCounts {
  /** Versions waiting for this person's decision. */
  waiting: number;
  /** Their own versions that came back for changes. */
  returned: number;
}

export type ApprovalsSummary = ({ enabled: true } & ApprovalCounts) | { enabled: false };

export type ApprovalBox = "waiting" | "sent" | "involved";

export interface ApprovalPeopleAnswer {
  me: ApprovalPerson;
  company: { id: string; name: string };
  people: Array<ApprovalPerson & { about: string | null }>;
}

/** A file of this workspace and its approval, as the file's own screen shows them. */
export interface FileApprovalStatus {
  enabled: boolean;
  /** The open approval of this file, if it has one. */
  approval: Approval | null;
  /** What the file holds now: gone when it is not there any more. */
  current: { exists: boolean; sha256: string | null; size: number; versionN: number | null; tooLarge: boolean };
  /** The newest round's version is not what the file holds now. */
  changedSinceSent: boolean;
  /** Most a file sent for approval can be. */
  maxBytes: number;
}

export const APPROVAL_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const APPROVAL_MAX_CHAIN = 10;
export const APPROVAL_MAX_NOTE_CHARS = 2000;
export const APPROVAL_MAX_COMMENT_CHARS = 4000;

/** Whether a version is still somebody's business: going round, or approved and standing. */
export function approvalIsOpen(approval: Pick<Approval, "status">): boolean {
  return approval.status === "active" || approval.status === "approved";
}
