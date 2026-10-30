/** Shapes the company-projects service answers with. Client-safe. */
import type { ChatMessage } from "@/lib/types";

export interface CompanyProject {
  id: string;
  projectId: string;
  title: string;
  welcome: string | null;
  /** Whose project it is, as the company names its administrator. */
  from: string;
  company: string;
}

export interface CompanyConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}

export interface CompanyConversation {
  id: string;
  title: string;
  /** As stored in the administrator's workspace, what a guest may see of it (lib/external/guest-turn.ts). */
  messages: ChatMessage[];
  /** A turn is working in it now. */
  running: boolean;
}

export type CompanyProjectsList = { enabled: false } | { enabled: true; projects: CompanyProject[] };

/** A conversation id as the service makes them; anything else is not one. */
export function conversationIdOf(raw: string | null | undefined): string | null {
  const id = String(raw || "").trim();
  return /^[a-z0-9]{8,24}$/.test(id) ? id : null;
}
