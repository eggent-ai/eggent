/**
 * Messages with the other people of this workspace's company, as the browser
 * and the agent see them. Client-safe: no Node imports.
 *
 * The messages themselves are kept by the service at EGGENT_MAIL_API_URL; this
 * workspace keeps only its copies of the files sent with them (sync.ts) and,
 * for a chat that answers a message, which message that was (MailReplyInfo).
 */

export type MailRole = "owner" | "member";
export type MailAuthorKind = "person" | "agent";
export type MailVia = "web" | "agent" | "telegram" | "api";

export interface MailContact {
  id: string;
  name: string;
  role: MailRole;
  /** What the person does, as the company wrote it down. */
  about: string | null;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: { id: number; preview: string; fromMe: boolean; authorKind: MailAuthorKind } | null;
}

export interface MailAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Where this workspace's own copy is, relative to the orchestrator's files; absent until it is taken. */
  localPath?: string | null;
}

export interface MailMessage {
  id: number;
  fromMe: boolean;
  author: { id: string; name: string; kind: MailAuthorKind };
  via: MailVia;
  text: string;
  replyTo: { id: number; preview: string; authorName: string } | null;
  createdAt: string;
  attachments: MailAttachment[];
}

export interface MailMe {
  instanceId: string;
  orgName: string;
  role: MailRole;
  name: string;
}

export type MailContactsAnswer =
  | { enabled: false }
  | { enabled: true; me: MailMe; company: { id: string; name: string }; contacts: MailContact[]; unreadTotal: number };

export interface MailThreadAnswer {
  contact: { id: string; name: string; role: MailRole; about: string | null };
  messages: MailMessage[];
  hasMore: boolean;
  /** How far the other side has read this thread, by message id. */
  contactReadUpTo: number;
}

/**
 * A chat opened to answer a message: who wrote it and what they wrote. The
 * agent is shown the message as material, and the answers in the chat can be
 * sent back to that person with a button under each.
 */
export interface MailReplyInfo {
  contactId: string;
  contactName: string;
  messageId: number;
  /** The message as it was written, cut to a few thousand characters. */
  quote: string;
  /** When it was written. */
  at: string;
  /** This workspace's copies of the files sent with it, relative to the orchestrator's files. */
  files?: string[];
}

/** "Ann" or "Ann (via agent)": who wrote a message, as the reader sees it. */
export function mailAuthorLabel(message: Pick<MailMessage, "author">, viaAgent: (name: string) => string): string {
  return message.author.kind === "agent" ? viaAgent(message.author.name) : message.author.name;
}
