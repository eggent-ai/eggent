/**
 * The agent's tools for sending to Telegram.
 *
 * Built for a chat's own session (eggent-tools.ts) and for a helper started
 * with the Agent tool (pi/helper-tools.ts). The two differ only in where a send
 * goes and what is remembered after it, so those are passed in; what the tools
 * say and how they send is one copy.
 */
import fs from "fs/promises";
import path from "path";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withChatFooter } from "@/lib/telegram/format";
import {
  looksLikePhoto,
  sendTelegramDocument,
  sendTelegramPhoto,
  sendTelegramText,
  type TelegramDestination,
  type TelegramSendResult,
} from "@/lib/telegram/outbound";

const TELEGRAM_SEND_FILE_MAX_BYTES = 45 * 1024 * 1024;

export interface TelegramToolsOptions {
  /** Where relative file paths are read from; the session's own working directory when absent. */
  cwd?: string;
  /** Where a send goes: the person's own chat without `chat`, else that chat. Read when the tool runs. */
  destination: (chat: string | undefined, ctx: ExtensionContext | undefined) => Promise<TelegramDestination | null>;
  /** The title a message to the person's own chat is signed with, or null for none. */
  footerTitle: (ctx: ExtensionContext | undefined) => Promise<string | null>;
  /** After a send to the person's own chat (not a channel), successful or not. */
  afterOwnChat: (
    destination: TelegramDestination,
    result: TelegramSendResult,
    kind: "text" | "file",
    ctx: ExtensionContext | undefined
  ) => Promise<void>;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

// Naming a chat fails for its own reasons, and "no chat to send to" would send
// the user off connecting a bot they already have.
function noDestinationResult(chat?: string) {
  return textResult(JSON.stringify(
    chat
      ? {
          success: false,
          error: `Cannot publish to ${chat} from this workspace.`,
          note: "Publishing to a named chat needs this workspace's own bot, connected in Settings -> Messengers, and that bot must be an administrator there. Give the channel as @name, a t.me link, or its numeric id.",
        }
      : {
          success: false,
          error: "This workspace has no Telegram chat to send to.",
          note: "Tell the user to connect a bot in Settings -> Messengers, or to write to the bot once so the workspace learns where to reply.",
        },
    null,
    2
  ));
}

function resolveFilePath(cwd: string | undefined, rawPath: string): string {
  const value = rawPath.trim();
  if (!value) throw new Error("file path is required");
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(cwd || process.cwd(), value);
}

export function createTelegramTools(options: TelegramToolsOptions): ToolDefinition[] {
  const sendMessage = defineTool({
    name: "telegram_send_message",
    label: "Send Telegram Message",
    description: "Send a plain text message to Telegram. Without `chat` it goes to this workspace's own chat: use that when the user asks to be written to, notified, reminded, or sent a result - including from a scheduled or background run. Pass `chat` to publish somewhere else, such as a channel the bot administers. Do not write the text into a file and send the file instead: that is what this tool exists to avoid.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text. Plain text; keep it short enough for a chat message." }),
      chat: Type.Optional(Type.String({ description: "Where to publish, when it is not this workspace's own chat: @channelname, a t.me link, or the numeric id. The workspace's own bot must be an administrator there." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const destination = await options.destination(params.chat, ctx);
      if (!destination) return noDestinationResult(params.chat);
      const title = params.chat ? null : await options.footerTitle(ctx);
      const result = await sendTelegramText(destination, title ? withChatFooter(params.text, title) : params.text);
      if (!params.chat) await options.afterOwnChat(destination, result, "text", ctx);
      return textResult(JSON.stringify({ success: result.success, via: result.via, ...(result.error ? { error: result.error } : {}) }, null, 2), { via: result.via });
    },
  });

  const sendFile = defineTool({
    name: "telegram_send_file",
    label: "Send File to Telegram",
    description: "Send a local file to Telegram. Images go as pictures with the caption under them, which is what a post looks like; everything else goes as a document. Pass `chat` to publish somewhere other than this workspace's own chat, such as a channel the bot administers. Set `as_file` only when the user explicitly wants an image delivered as a downloadable file.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the file, or path relative to the current project cwd." }),
      caption: Type.Optional(Type.String({ description: "Optional caption. For an image this becomes the post text under the picture." })),
      chat: Type.Optional(Type.String({ description: "Where to publish, when it is not this workspace's own chat: @channelname, a t.me link, or the numeric id. The workspace's own bot must be an administrator there." })),
      as_file: Type.Optional(Type.Boolean({ description: "Send an image as a document instead of a picture. Only when the user asked for the original file." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const destination = await options.destination(params.chat, ctx);
      if (!destination) return noDestinationResult(params.chat);
      try {
        const resolvedPath = resolveFilePath(options.cwd || ctx?.cwd, params.file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return textResult(JSON.stringify({ success: false, error: `Path is not a file: ${resolvedPath}` }, null, 2));
        }
        if (stat.size > TELEGRAM_SEND_FILE_MAX_BYTES) {
          return textResult(JSON.stringify({ success: false, error: `File is too large (${stat.size} bytes). Max allowed is ${TELEGRAM_SEND_FILE_MAX_BYTES} bytes.` }, null, 2));
        }

        const name = path.basename(resolvedPath);
        const asPhoto = !params.as_file && looksLikePhoto(name);
        const payload = { buffer: await fs.readFile(resolvedPath), name, caption: params.caption };
        const result = asPhoto
          ? await sendTelegramPhoto(destination, payload)
          : await sendTelegramDocument(destination, payload);
        if (!params.chat) await options.afterOwnChat(destination, result, "file", ctx);
        return textResult(JSON.stringify({
          success: result.success,
          via: result.via,
          ...(result.error ? { error: result.error } : {}),
          path: resolvedPath,
          name,
          size: stat.size,
          sentAs: asPhoto ? "photo" : "document",
        }, null, 2), { via: result.via });
      } catch (error) {
        return textResult(JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Failed to send file to Telegram." }, null, 2));
      }
    },
  });

  return [sendMessage, sendFile] as unknown as ToolDefinition[];
}
