import type { SteerRequest } from "@/lib/pi/active-runs";
import type { SteerQueueItem } from "@/lib/pi/steer-shape";
import { getChatFiles } from "@/lib/storage/chat-files-store";
import { getChat, saveChat } from "@/lib/storage/chat-store";
import type { ChatFile } from "@/lib/types";

/**
 * Messages said to a turn while it works.
 *
 * The runtime has had this all along: `steer` puts a message in front of the
 * model after the step it is on and before the next call, which is where a
 * correction is still worth something. The web chat could not use it - its
 * composer refused to send anything while a turn ran - so the one way to correct
 * the agent was Stop, which threw away the answer in progress and made the
 * person type the whole request again. Ten of the eighteen "stream ended"
 * errors of one week were one person doing exactly that.
 *
 * A turn keeps its own record of what was said to it, because the stored chat
 * has to show it where the agent read it, not where it was typed: between the
 * part of the answer before and the part after. What the agent never got to
 * read - the turn was stopped, or failed - stays in the chat, marked, so it is
 * not silently lost.
 */

/** A message said to this turn, and when the agent read it. */
export interface TurnSteer extends SteerRequest {
  deliveredAt?: string;
}

export class TurnSteers {
  private readonly queued: TurnSteer[] = [];
  private readonly read = new Map<string, TurnSteer>();
  private promptPending = false;

  /**
   * The next person's message the session puts in front of the model is the
   * prompt itself, not one of these. Called just before `session.prompt`: the
   * runtime announces the prompt first, and the same words sent twice must not
   * be taken for the steer.
   */
  expectPrompt(): void {
    this.promptPending = true;
  }

  /** `session.prompt` returned: whatever it was going to announce, it has. */
  promptSettled(): void {
    this.promptPending = false;
  }

  add(request: SteerRequest): TurnSteer {
    const steer: TurnSteer = { ...request };
    this.queued.push(steer);
    return steer;
  }

  /** Handing it to the session failed: it was never on its way. */
  drop(messageId: string): void {
    const index = this.queued.findIndex((steer) => steer.messageId === messageId);
    if (index !== -1) this.queued.splice(index, 1);
  }

  /**
   * A person's message the session has just put in front of the model: which of
   * these it was, if any. Matched by the words, which is how the runtime itself
   * keeps track of its queue.
   */
  noteUserMessage(text: string, at = new Date().toISOString()): TurnSteer | null {
    if (this.promptPending) {
      this.promptPending = false;
      return null;
    }
    const index = this.queued.findIndex((steer) => steer.modelText === text);
    if (index === -1) return null;
    const [steer] = this.queued.splice(index, 1);
    steer.deliveredAt = at;
    this.read.set(steer.messageId, steer);
    return steer;
  }

  /** Waiting to be read, in the order they were sent. */
  queue(): SteerQueueItem[] {
    return this.queued.map(({ messageId, text, createdAt }) => ({ messageId, text, createdAt }));
  }

  hasQueued(): boolean {
    return this.queued.length > 0;
  }

  /** Read by the agent, by message id: the stored turn is cut at each. */
  delivered(): ReadonlyMap<string, TurnSteer> {
    return this.read;
  }

  /** The turn is over: what the agent never read. */
  takeUndelivered(): TurnSteer[] {
    return this.queued.splice(0, this.queued.length);
  }
}

/** The words of a person's message as the runtime announces it. */
export function userMessageText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") return null;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return null;
  return record.content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/** At most this many files are named with one message: a folder dropped in whole is not a list to read out. */
const MAX_STEER_FILES = 20;

/**
 * The chat's files with these names, for a message sent in the middle of a turn.
 *
 * A turn learns about the chat's files once, when its session is built, so a
 * file uploaded while it works is one the agent has never heard of: the message
 * it came with names it, with the path to read it by.
 */
export async function filesSentWith(chatId: string, names: unknown): Promise<ChatFile[]> {
  if (!Array.isArray(names) || names.length === 0) return [];
  const wanted = new Set(names.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length < 512));
  if (wanted.size === 0) return [];
  const files = await getChatFiles(chatId).catch(() => [] as ChatFile[]);
  return files.filter((file) => wanted.has(file.name)).slice(0, MAX_STEER_FILES);
}

/** What the agent reads for a message sent in the middle of a turn. */
export function steerModelText(text: string, files: ChatFile[]): string {
  if (files.length === 0) return text;
  return [
    text,
    "",
    "Sent with this message (read them by the absolute path):",
    ...files.map((file) => `- ${file.name} (${file.type}): ${file.path}`),
  ].join("\n");
}

/**
 * Written down the moment it is sent, at the end of the chat: a reload shows it
 * waiting, and the turn moves it to where the agent read it. One sent again
 * after the turn it was meant for ended without reading it replaces that copy.
 */
export async function storeQueuedSteer(chatId: string, runId: string, steer: SteerRequest): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) return;
  const now = new Date().toISOString();
  chat.messages = chat.messages.filter((message) => message.id !== steer.messageId);
  chat.messages.push({
    id: steer.messageId,
    role: "user",
    content: steer.text,
    createdAt: steer.createdAt,
    steer: { runId, state: "queued" },
  });
  chat.updatedAt = now;
  await saveChat(chat);
}

/**
 * The turn ended before the agent read these: they stay where they are, marked,
 * and the chat offers to send them again. One that never reached the file is
 * written now, so it is not lost either.
 */
export async function markSteersUndelivered(chatId: string, runId: string, steers: TurnSteer[]): Promise<void> {
  if (steers.length === 0) return;
  const chat = await getChat(chatId);
  if (!chat) return;
  for (const steer of steers) {
    const stored = chat.messages.find((message) => message.id === steer.messageId);
    if (stored) {
      stored.steer = { runId, state: "undelivered" };
    } else {
      chat.messages.push({
        id: steer.messageId,
        role: "user",
        content: steer.text,
        createdAt: steer.createdAt,
        steer: { runId, state: "undelivered" },
      });
    }
  }
  chat.updatedAt = new Date().toISOString();
  await saveChat(chat);
}
