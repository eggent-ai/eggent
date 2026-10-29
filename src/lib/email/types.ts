/** The shapes the email service answers with (see config.ts). */

export interface EmailAttachmentInfo {
  n: number;
  name: string;
  size: number;
  mime: string;
  /** Why the file deserves a second look before anybody opens it: executable, macro, archive, disguised. */
  danger?: string | null;
}

export interface EmailSummary {
  id: number;
  direction: "in" | "out";
  folder: "inbox" | "other" | "sent" | "bounce" | string;
  status: string;
  from: { address: string | null; name: string | null };
  to: string[];
  subject: string;
  preview: string;
  at: string;
  read: boolean;
  /** From the person's own confirmed address, and the sender's domain vouched for it. */
  fromOwner: boolean;
  /** The sender's domain vouched for the From address. */
  authenticated: boolean;
  /** A reply to one of the agent's own letters. */
  threadReply: boolean;
  /** For a reply: the agent's own letter it answers. Absent from a service that does not say. */
  answers?: number | null;
  /** For a letter the agent sent after the person's yes: the request it was asked under. */
  requestId?: string | null;
  /** Why the service doubts who sent it. */
  suspicious: string | null;
  /** Why a letter the agent sent did not go. */
  error?: string | null;
  attachments: EmailAttachmentInfo[];
  size: number;
}

export interface EmailMessage extends EmailSummary {
  text: string;
  messageId: string | null;
}

export interface EmailRequestView {
  id: string;
  to: string[];
  subject: string;
  status: string;
  waitsIn: "telegram" | "email" | null;
  createdAt: string;
  expiresAt: string;
  decidedVia: string | null;
  error: string | null;
}

export interface EmailStatus {
  enabled: boolean;
  address?: string;
  /** `note` is the service's word to the agent when the address is not confirmed yet. */
  owner?: { confirmed: boolean; address: string | null; note?: string };
  limits?: {
    month: { used: number; limit: number };
    others: { allowed: boolean; monthUsed: number; monthLimit: number; dayUsed: number; dayLimit: number };
    resetsOn: string;
  };
  unread?: { inbox: number; other: number };
  approval?: "telegram" | "email" | null;
  pending?: EmailRequestView[];
}

export type EmailSendAnswer =
  | { status: "sent"; to: string[]; ids: number[]; failed: Array<{ address: string; error: string }> }
  | { status: "pending"; request: EmailRequestView };

/**
 * A reply to one of the agent's letters, told under the newest answer of the
 * chat the letter left from. Nothing in it is from the letter beyond who sent
 * it and its subject: the letter itself is read on its own page.
 */
export interface EmailReplyNotice {
  letterId: number;
  from: string;
  subject: string;
  at: string;
}

/**
 * A chat opened to deal with one letter: what the agent is shown, as material.
 * The letter was written outside the workspace, so it is never an instruction.
 */
export interface EmailLetterInfo {
  letterId: number;
  from: string;
  /** The checked words about who sent it (see trustOf in tool.ts). */
  sender: string;
  subject: string;
  at: string;
  /** The letter as it came, cut to a few thousand characters. */
  quote: string;
  /** This workspace's copies of its files, absolute paths. */
  files?: string[];
}
