import { redactSecrets } from "@/lib/pi/provider-failure";
import type { ChatMessage, ChatMessagePart } from "@/lib/types";

/**
 * What the reviewer is shown of a conversation.
 *
 * Not the transcript. A full history can be hundreds of thousands of tokens,
 * most of it tool output - whole pages, file dumps - and replaying it for a
 * look that usually ends in "nothing to keep" would cost more than everything
 * it could ever save. The digest keeps what a person would read to judge the
 * exchange: what they said, what the agent answered, and one line for each
 * thing the agent did.
 *
 * It leaves out what tools returned, except the first line of a failure. That
 * is as much a precaution as a saving: a tool result is text from outside - a
 * web page, a file someone else wrote - and the reviewer writes what it reads
 * into a file that is shown to the model forever. What the person said and
 * what the agent did are the evidence; what a page said is not.
 */

const USER_CLIP = 1200;
const ASSISTANT_CLIP = 1200;
const ERROR_CLIP = 160;
const ARG_CLIP = 90;
const ARGS_TOTAL_CLIP = 200;

/**
 * Flattened, cut to length, and with anything shaped like a credential masked.
 * The reviewer is told never to keep one; not showing it is the surer half.
 */
function clip(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

/** The part of a stored user message that is the person's own words. */
function personsWords(content: string): string {
  const cut = content.indexOf("\n\nRuntime data:");
  return cut >= 0 ? content.slice(0, cut) : content;
}

/** What a call was pointed at, in a handful of words. */
export function summariseArgs(args: Record<string, unknown>): string {
  const preferred = ["command", "path", "file_path", "query", "url", "name", "description", "action", "text", "prompt"];
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null);
  entries.sort(([a], [b]) => {
    const rank = (key: string) => (preferred.includes(key) ? preferred.indexOf(key) : 99);
    return rank(a) - rank(b);
  });
  const parts: string[] = [];
  for (const [key, value] of entries.slice(0, 3)) {
    const shown = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "\u2026";
    parts.push(`${key}=${clip(shown, ARG_CLIP)}`);
  }
  return clip(parts.join(", "), ARGS_TOTAL_CLIP);
}

function firstLineOf(output: unknown): string {
  const text = typeof output === "string" ? output : (() => {
    try {
      return JSON.stringify(output ?? "");
    } catch {
      return "";
    }
  })();
  return clip(text.split("\n").find((line) => line.trim()) ?? "", ERROR_CLIP);
}

function renderAssistant(message: ChatMessage): string[] {
  const lines: string[] = [];
  const parts: ChatMessagePart[] = message.parts?.length
    ? message.parts
    : [
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
          status: "completed" as const,
        })),
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ];
  let text = "";
  const flushText = () => {
    if (!text.trim()) return;
    lines.push(`ASSISTANT: ${clip(text, ASSISTANT_CLIP)}`);
    text = "";
  };
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    flushText();
    const outcome = part.status === "error" ? `ERROR: ${firstLineOf(part.output)}` : "ok";
    lines.push(`  tool ${part.toolName}(${summariseArgs(part.args ?? {})}) -> ${outcome}`);
  }
  flushText();
  if (message.learned?.items?.length) lines.push("  (the agent saved notes after this answer)");
  return lines;
}

export interface DigestOptions {
  maxChars: number;
  /** How many of the person's messages, counting back from the last, to include. */
  userTurns: number;
}

/** The conversation's last turns, as plain lines. Empty when there is nothing to show. */
export function buildDigest(messages: ChatMessage[], options: DigestOptions): string {
  const userIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") userIndexes.push(index);
  });
  if (userIndexes.length === 0) return "";
  const start = userIndexes[Math.max(0, userIndexes.length - options.userTurns)];

  const lines: string[] = [];
  for (const message of messages.slice(start)) {
    if (message.role === "user") {
      const words = clip(personsWords(message.content), USER_CLIP);
      if (words) lines.push(`USER: ${words}`);
    } else if (message.role === "assistant") {
      lines.push(...renderAssistant(message));
    }
  }

  // Older lines go first when it is too long: the end of the exchange is what
  // the review is about.
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (lines.length > 1 && total > options.maxChars) {
    total -= lines[0].length + 1;
    lines.shift();
  }
  const text = lines.join("\n");
  return text.length > options.maxChars ? text.slice(text.length - options.maxChars) : text;
}
