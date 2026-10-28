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
  owner?: { confirmed: boolean; address: string | null };
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
