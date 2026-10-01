import { getAllChats, getChat } from "@/lib/storage/chat-store";
import { getAllProjects } from "@/lib/storage/project-store";
import { redactSecrets } from "@/lib/pi/provider-failure";
import type { Chat, ChatListItem, ChatMessage } from "@/lib/types";

/**
 * Other chats, as the agent and the Telegram /chats command see them.
 *
 * Everything that leaves here is text somebody will read in a different
 * conversation from the one it was written in, so it is cut to size and has
 * credentials masked: people paste bot tokens and API keys into chats, and a
 * chat list must not carry them into a second one.
 */

const RUNTIME_DATA_MARKER = "\n\nRuntime data:\n";

export interface ChatSummary {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string;
  messageCount: number;
  /** The scheduled task that wrote this chat, when one did. */
  scheduledJob?: string;
}

export interface ChatSearchHit {
  chatId: string;
  title: string;
  projectName: string | null;
  at: string;
  role: "user" | "assistant";
  snippet: string;
}

/**
 * The part of a stored message a person wrote or read.
 *
 * A message that arrived through Telegram is stored with the runtime facts the
 * agent was handed under it; that is plumbing, not conversation.
 */
export function messageText(message: Pick<ChatMessage, "content">): string {
  const content = message.content || "";
  const cut = content.indexOf(RUNTIME_DATA_MARKER);
  return redactSecrets((cut >= 0 ? content.slice(0, cut) : content).trim());
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The handle a chat is opened by from Telegram: /c_<this>. */
export function chatShortId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
}

/** Only the conversation itself: tool output is noisy and is where secrets sit. */
function isConversationMessage(message: ChatMessage): message is ChatMessage & { role: "user" | "assistant" } {
  return (message.role === "user" || message.role === "assistant") && Boolean(messageText(message));
}

async function projectNames(): Promise<Map<string, string>> {
  return new Map((await getAllProjects()).map((project) => [project.id, project.name]));
}

function summarize(chat: ChatListItem, names: Map<string, string>): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId ?? null,
    projectName: chat.projectId ? names.get(chat.projectId) ?? chat.projectId : null,
    updatedAt: chat.updatedAt,
    messageCount: chat.messageCount,
    ...(chat.scheduledJob ? { scheduledJob: chat.scheduledJob } : {}),
  };
}

/**
 * Recent chats with something in them, newest first.
 *
 * `projectId` narrows to one project, `null` to the orchestrator; left out, it
 * is every chat in the workspace.
 */
export async function listChatSummaries(options: {
  projectId?: string | null;
  limit?: number;
} = {}): Promise<ChatSummary[]> {
  const names = await projectNames();
  const limit = Math.max(1, Math.min(options.limit ?? 15, 50));
  return (await getAllChats())
    .filter((chat) => chat.messageCount > 0)
    .filter((chat) =>
      options.projectId === undefined ? true : (chat.projectId ?? null) === (options.projectId ?? null)
    )
    .slice(0, limit)
    .map((chat) => summarize(chat, names));
}

/** A case-insensitive search through what was said, newest chats first. */
export async function searchChats(query: string, limit = 10): Promise<ChatSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const names = await projectNames();
  const hits: ChatSearchHit[] = [];
  for (const item of await getAllChats()) {
    if (hits.length >= limit) break;
    const chat = await getChat(item.id);
    if (!chat) continue;
    const titleHit = chat.title.toLowerCase().includes(needle);
    // Newest message first: the latest mention is usually the one meant.
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const message = chat.messages[index];
      if (!isConversationMessage(message)) continue;
      const text = messageText(message);
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 80);
      hits.push({
        chatId: chat.id,
        title: chat.title,
        projectName: chat.projectId ? names.get(chat.projectId) ?? chat.projectId : null,
        at: message.createdAt,
        role: message.role,
        snippet: `${start > 0 ? "…" : ""}${clip(text.slice(start), 240)}`,
      });
      break;
    }
    if (titleHit && !hits.some((hit) => hit.chatId === chat.id)) {
      const last = [...chat.messages].reverse().find(isConversationMessage);
      hits.push({
        chatId: chat.id,
        title: chat.title,
        projectName: chat.projectId ? names.get(chat.projectId) ?? chat.projectId : null,
        at: chat.updatedAt,
        role: last?.role ?? "assistant",
        snippet: last ? clip(messageText(last), 240) : "",
      });
    }
  }
  return hits.slice(0, limit);
}

/**
 * A page of one chat's conversation, the latest messages by default.
 *
 * `before` is the index of the first message already read, so paging back is
 * the same call with the index it returned.
 */
export async function readChatConversation(
  chatId: string,
  options: { limit?: number; before?: number } = {}
): Promise<{
  chat: ChatSummary;
  messages: Array<{ index: number; role: "user" | "assistant"; at: string; text: string }>;
  earlier: number | null;
} | null> {
  const chat = await getChat(chatId);
  if (!chat) return null;
  const names = await projectNames();
  const conversation = chat.messages
    .map((message, index) => ({ message, index }))
    .filter((entry): entry is { message: ChatMessage & { role: "user" | "assistant" }; index: number } =>
      isConversationMessage(entry.message)
    );
  const limit = Math.max(1, Math.min(options.limit ?? 20, 60));
  const upTo = options.before === undefined
    ? conversation.length
    : conversation.filter((entry) => entry.index < options.before!).length;
  const page = conversation.slice(Math.max(0, upTo - limit), upTo);
  const first = page[0];
  return {
    chat: summarize({
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
      scheduledJob: chat.scheduledRun?.jobName,
    }, names),
    messages: page.map(({ message, index }) => ({
      index,
      role: message.role,
      at: message.createdAt,
      text: clip(messageText(message), 2000),
    })),
    earlier: first && conversation.indexOf(first) > 0 ? first.index : null,
  };
}

/** The chat a /c_<id> command names, when exactly one matches. */
export async function findChatByShortId(shortId: string): Promise<Chat | null> {
  const wanted = shortId.trim().toLowerCase();
  if (wanted.length < 4) return null;
  const matches = (await getAllChats()).filter((chat) => chatShortId(chat.id).startsWith(wanted));
  if (matches.length !== 1) return null;
  return getChat(matches[0].id);
}

/** The last thing said in a chat, for a line that says where the person now is. */
export function lastConversationLine(chat: Chat): string {
  const last = [...chat.messages].reverse().find(isConversationMessage);
  return last ? clip(messageText(last).replace(/\s+/g, " "), 300) : "";
}
