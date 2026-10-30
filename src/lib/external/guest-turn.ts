import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { createPiChatUIMessageStream } from "@/lib/pi/chat-runner";
import { attachToLiveRun, getLiveRun } from "@/lib/pi/live-run";
import { getActiveRun, stopActiveRun } from "@/lib/pi/active-runs";
import { respondToPendingInteraction, getPendingInteraction } from "@/lib/pi/pending-interactions";
import { getChat } from "@/lib/storage/chat-store";
import { getExternalSession, sessionChatId } from "@/lib/storage/external-session-store";
import { resolveGuestSessionChat } from "@/lib/external/handle-external-message";
import type { ChatMessage } from "@/lib/types";

/**
 * A guest's turn: somebody asking a shared project - a visitor of a public
 * link, or a person of the company asking the administrator's project - from a
 * screen that shows the answer as the workspace's own chat does.
 *
 * Everything is keyed by the session id the host chose (`share:<link>:...`,
 * `company:<link>:...`); the session decides the chat, and nothing here takes
 * a chat id or a run id on trust: a stop or an answer is for the run that is
 * working in that session's chat, or it is nothing. The turn itself is a
 * public-share turn (lib/pi/public-share.ts), whatever the host.
 */

export const GUEST_MAX_MESSAGE = 8000;

/**
 * Parts a guest is not shown: what the turn cost and on which model, the
 * workspace's file cards and notices. The answer, the tools it used and its
 * questions are the conversation; these are the owner's.
 */
const HIDDEN_PART_TYPES = new Set(["data-piStats", "data-eggentFiles", "data-eggentNotice", "data-piCompaction"]);

export class GuestTurnError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A UI message stream with the owner's parts taken out, line by line as it goes. */
export function guestVisibleStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const keep = (frame: string) => {
    const data = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!data) return true;
    try {
      const part = JSON.parse(data.slice(5).trim()) as { type?: unknown };
      return !(typeof part.type === "string" && HIDDEN_PART_TYPES.has(part.type));
    } catch {
      return true;
    }
  };
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buffer.slice(0, cut + 2);
        buffer = buffer.slice(cut + 2);
        if (keep(frame)) controller.enqueue(encoder.encode(frame));
        cut = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      if (buffer && keep(buffer)) controller.enqueue(encoder.encode(buffer));
    },
  }));
}

function guestResponse(response: Response, headers: Record<string, string> = {}): Response {
  if (!response.body) return response;
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  merged.set("Cache-Control", "no-cache, no-transform");
  merged.set("X-Accel-Buffering", "no");
  return new Response(guestVisibleStream(response.body), { status: response.status, headers: merged });
}

/** Ask: the answer comes back as the workspace chat's own stream, cards and all. */
export async function guestTurnResponse(input: {
  sessionId: string;
  projectId: string;
  message: string;
  toolRuntimeData?: Record<string, unknown>;
}): Promise<Response> {
  const message = input.message.trim();
  if (!message) throw new GuestTurnError("The message is empty.", 400, "emptyMessage");
  if (message.length > GUEST_MAX_MESSAGE) throw new GuestTurnError("The message is too long.", 413, "tooLong");
  const { chatId, projectId } = await resolveGuestSessionChat(input.sessionId, input.projectId);
  // A message while the turn works waits for it to end: a guest has no way to
  // say something to a working turn, and a second turn would race the first.
  if (getActiveRun(chatId)) throw new GuestTurnError("The answer to the last message is still being written.", 409, "busy");
  const stream = createPiChatUIMessageStream({
    chatId,
    projectId,
    userMessage: message,
    publicShare: true,
    enableEggentTools: false,
    toolRuntimeData: input.toolRuntimeData,
  });
  return guestResponse(createUIMessageStreamResponse({ stream }));
}

/** The chat a guest session talks in, if it has one yet. */
async function chatIdOf(sessionId: string): Promise<string | null> {
  let session;
  try {
    session = await getExternalSession(sessionId);
  } catch {
    return null;
  }
  return session ? sessionChatId(session) : null;
}

/** What a guest sees of a stored message: the words, the tools, the questions; not the cost or the files. */
function guestMessage(message: ChatMessage): ChatMessage {
  const { piRuntimeStats: _stats, learned: _learned, files: _files, ...rest } = message as ChatMessage & Record<string, unknown>;
  void _stats;
  void _learned;
  void _files;
  return {
    ...rest,
    ...(message.parts ? { parts: message.parts.filter((part) => !HIDDEN_PART_TYPES.has((part as { type?: string }).type ?? "")) } : {}),
  } as ChatMessage;
}

export interface GuestChatView {
  title: string;
  messages: ChatMessage[];
  /** A turn is working in it now: attach to it to see the rest. */
  running: boolean;
}

export async function guestChat(sessionId: string): Promise<GuestChatView | null> {
  const chatId = await chatIdOf(sessionId);
  const chat = chatId ? await getChat(chatId) : null;
  if (!chat || !chatId) return null;
  return {
    title: chat.title,
    messages: chat.messages.filter((message) => message.role !== "system").map(guestMessage),
    running: Boolean(getActiveRun(chatId)),
  };
}

/** A conversation as a list shows it: what was first asked, when it last moved. */
export async function guestConversationSummary(sessionId: string): Promise<{ title: string; updatedAt: string; messages: number } | null> {
  const chatId = await chatIdOf(sessionId);
  const chat = chatId ? await getChat(chatId) : null;
  if (!chat) return null;
  const said = chat.messages.filter((message) => message.role === "user" || message.role === "assistant");
  const first = said.find((message) => message.role === "user" && message.content.trim());
  const text = first ? first.content.replace(/\s+/g, " ").trim() : "";
  return { title: text.length > 80 ? `${text.slice(0, 79)}…` : text, updatedAt: chat.updatedAt, messages: said.length };
}

/** The turn working in this session's chat, from its beginning, or 204 when there is none. */
export async function guestResumeResponse(sessionId: string, signal: AbortSignal): Promise<Response> {
  const chatId = await chatIdOf(sessionId);
  if (!chatId || !getLiveRun(chatId)) return new Response(null, { status: 204 });
  const stream = createUIMessageStream<UIMessage>({
    execute: ({ writer }) =>
      new Promise<void>((resolve) => {
        const attached = attachToLiveRun(chatId, { onChunk: (chunk) => writer.write(chunk), onFinish: () => resolve() });
        if (!attached) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          attached.detach();
          resolve();
        }, { once: true });
      }),
  });
  return guestResponse(createUIMessageStreamResponse({ stream }));
}

export async function guestStop(sessionId: string): Promise<boolean> {
  const chatId = await chatIdOf(sessionId);
  return chatId ? await stopActiveRun(chatId) : false;
}

/** Answer a card, only one the run now working in this session's chat put up. */
export async function guestAnswer(sessionId: string, input: { interactionId: string; value?: unknown; cancel?: boolean }): Promise<boolean> {
  const chatId = await chatIdOf(sessionId);
  const run = chatId ? getActiveRun(chatId) : undefined;
  const interaction = getPendingInteraction(input.interactionId);
  if (!run || !interaction || interaction.runId !== run.runId || interaction.status !== "pending") return false;
  // A guest's card asks for words, a choice or a yes/no; nothing else may be answered from here.
  if (!["text", "select", "confirm"].includes(interaction.kind)) return false;
  const value = typeof input.value === "string" ? input.value.slice(0, GUEST_MAX_MESSAGE) : typeof input.value === "boolean" ? input.value : null;
  try {
    respondToPendingInteraction(run.runId, interaction.id, { value, cancel: input.cancel === true });
    return true;
  } catch {
    return false;
  }
}
