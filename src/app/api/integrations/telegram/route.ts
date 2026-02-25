import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  ExternalMessageError,
  handleExternalMessage,
} from "@/lib/external/handle-external-message";
import {
  createDefaultTelegramSessionId,
  createFreshTelegramSessionId,
  getTelegramChatSessionId,
  setTelegramChatSessionId,
} from "@/lib/storage/telegram-session-store";
import {
  claimTelegramUpdate,
  releaseTelegramUpdate,
} from "@/lib/storage/telegram-update-store";
import {
  consumeTelegramAccessCode,
  getTelegramIntegrationRuntimeConfig,
  normalizeTelegramUserId,
} from "@/lib/storage/telegram-integration-store";
import { saveChatFile } from "@/lib/storage/chat-files-store";
import { createChat, getChat } from "@/lib/storage/chat-store";
import {
  contextKey,
  type ExternalSession,
  getOrCreateExternalSession,
  saveExternalSession,
} from "@/lib/storage/external-session-store";
import { getAllProjects } from "@/lib/storage/project-store";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_FILE_MAX_BYTES = 30 * 1024 * 1024;

interface TelegramUpdate {
  update_id?: unknown;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id?: unknown;
  text?: unknown;
  caption?: unknown;
  from?: {
    id?: unknown;
  };
  chat?: {
    id?: unknown;
    type?: unknown;
  };
  document?: {
    file_id?: unknown;
    file_name?: unknown;
    mime_type?: unknown;
  };
  photo?: Array<{
    file_id?: unknown;
    width?: unknown;
    height?: unknown;
  }>;
  audio?: {
    file_id?: unknown;
    file_name?: unknown;
    mime_type?: unknown;
  };
  video?: {
    file_id?: unknown;
    file_name?: unknown;
    mime_type?: unknown;
  };
  voice?: {
    file_id?: unknown;
    mime_type?: unknown;
  };
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: Record<string, unknown>;
}

interface TelegramIncomingFile {
  fileId: string;
  fileName: string;
}

interface TelegramExternalChatContext {
  chatId: string;
  projectId?: string;
  currentPath: string;
}

function normalizeTelegramCurrentPath(rawPath: string | undefined): string {
  const value = (rawPath ?? "").trim();
  if (!value || value === "/telegram") {
    return "";
  }
  return value;
}

interface TelegramResolvedProjectContext {
  session: ExternalSession;
  resolvedProjectId?: string;
  projectName?: string;
}

function parseTelegramError(status: number, payload: TelegramApiResponse | null): string {
  const description = payload?.description?.trim();
  return description
    ? `Telegram API error (${status}): ${description}`
    : `Telegram API error (${status})`;
}

async function callTelegramApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as
    | TelegramApiResponse
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
  return payload;
}

function safeTokenMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(actualBytes, expectedBytes);
}

function getBotId(botToken: string): string {
  const [rawBotId] = botToken.trim().split(":", 1);
  const botId = rawBotId?.trim() || "default";
  return botId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "default";
}

function chatBelongsToProject(
  chatProjectId: string | undefined,
  projectId: string | undefined
): boolean {
  const left = chatProjectId ?? null;
  const right = projectId ?? null;
  return left === right;
}

async function ensureTelegramExternalChatContext(params: {
  sessionId: string;
  defaultProjectId?: string;
}): Promise<TelegramExternalChatContext> {
  const { session, resolvedProjectId } = await resolveTelegramProjectContext({
    sessionId: params.sessionId,
    defaultProjectId: params.defaultProjectId,
  });
  const projectKey = contextKey(resolvedProjectId);
  let resolvedChatId = session.activeChats[projectKey];
  if (resolvedChatId) {
    const existing = await getChat(resolvedChatId);
    if (!existing || !chatBelongsToProject(existing.projectId, resolvedProjectId)) {
      resolvedChatId = "";
    }
  }

  if (!resolvedChatId) {
    resolvedChatId = crypto.randomUUID();
    await createChat(
      resolvedChatId,
      `External session ${session.id}`,
      resolvedProjectId
    );
  }

  session.activeChats[projectKey] = resolvedChatId;
  session.currentPaths[projectKey] = normalizeTelegramCurrentPath(
    session.currentPaths[projectKey]
  );
  session.updatedAt = new Date().toISOString();
  await saveExternalSession(session);

  return {
    chatId: resolvedChatId,
    projectId: resolvedProjectId,
    currentPath: session.currentPaths[projectKey] ?? "",
  };
}

async function resolveTelegramProjectContext(params: {
  sessionId: string;
  defaultProjectId?: string;
}): Promise<TelegramResolvedProjectContext> {
  const session = await getOrCreateExternalSession(params.sessionId);
  const projects = await getAllProjects();
  const projectById = new Map(projects.map((project) => [project.id, project]));

  let resolvedProjectId: string | undefined;
  const explicitProjectId = params.defaultProjectId?.trim() || "";
  if (explicitProjectId) {
    if (!projectById.has(explicitProjectId)) {
      throw new Error(`Project "${explicitProjectId}" not found`);
    }
    resolvedProjectId = explicitProjectId;
    session.activeProjectId = explicitProjectId;
  } else if (session.activeProjectId && projectById.has(session.activeProjectId)) {
    resolvedProjectId = session.activeProjectId;
  } else if (projects.length > 0) {
    resolvedProjectId = projects[0].id;
    session.activeProjectId = projects[0].id;
  } else {
    session.activeProjectId = null;
  }

  return {
    session,
    resolvedProjectId,
    projectName: resolvedProjectId ? projectById.get(resolvedProjectId)?.name : undefined,
  };
}

function extensionFromMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("pdf")) return ".pdf";
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("mp4")) return ".mp4";
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("ogg")) return ".ogg";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("plain")) return ".txt";
  return "";
}

function buildIncomingFileName(params: {
  base: string;
  messageId?: number;
  mimeType?: string;
}): string {
  const suffix = params.messageId ?? Date.now();
  const ext = params.mimeType ? extensionFromMime(params.mimeType) : "";
  return `${params.base}-${suffix}${ext}`;
}

function sanitizeFileName(value: string): string {
  const base = value.trim().replace(/[\\/]+/g, "_");
  return base || `file-${Date.now()}`;
}

function withMessageIdPrefix(fileName: string, messageId?: number): string {
  if (typeof messageId !== "number") return fileName;
  return `${messageId}-${fileName}`;
}

function extractIncomingFile(
  message: TelegramMessage,
  messageId?: number
): TelegramIncomingFile | null {
  const documentFileId =
    typeof message.document?.file_id === "string"
      ? message.document.file_id.trim()
      : "";
  if (documentFileId) {
    const docNameRaw =
      typeof message.document?.file_name === "string"
        ? message.document.file_name
        : "";
    const fallback = buildIncomingFileName({
      base: "document",
      messageId,
      mimeType:
        typeof message.document?.mime_type === "string"
          ? message.document.mime_type
          : undefined,
    });
    return {
      fileId: documentFileId,
      fileName: withMessageIdPrefix(sanitizeFileName(docNameRaw || fallback), messageId),
    };
  }

  const photos: Array<{ file_id?: unknown }> = Array.isArray(message.photo)
    ? message.photo
    : [];
  for (let i = photos.length - 1; i >= 0; i -= 1) {
    const photo = photos[i];
    const fileId = typeof photo?.file_id === "string" ? photo.file_id.trim() : "";
    if (fileId) {
      return {
        fileId,
        fileName: sanitizeFileName(
          buildIncomingFileName({ base: "photo", messageId, mimeType: "image/jpeg" })
        ),
      };
    }
  }

  const audioFileId =
    typeof message.audio?.file_id === "string" ? message.audio.file_id.trim() : "";
  if (audioFileId) {
    const audioNameRaw =
      typeof message.audio?.file_name === "string" ? message.audio.file_name : "";
    const fallback = buildIncomingFileName({
      base: "audio",
      messageId,
      mimeType:
        typeof message.audio?.mime_type === "string"
          ? message.audio.mime_type
          : undefined,
    });
    return {
      fileId: audioFileId,
      fileName: withMessageIdPrefix(sanitizeFileName(audioNameRaw || fallback), messageId),
    };
  }

  const videoFileId =
    typeof message.video?.file_id === "string" ? message.video.file_id.trim() : "";
  if (videoFileId) {
    const videoNameRaw =
      typeof message.video?.file_name === "string" ? message.video.file_name : "";
    const fallback = buildIncomingFileName({
      base: "video",
      messageId,
      mimeType:
        typeof message.video?.mime_type === "string"
          ? message.video.mime_type
          : undefined,
    });
    return {
      fileId: videoFileId,
      fileName: withMessageIdPrefix(sanitizeFileName(videoNameRaw || fallback), messageId),
    };
  }

  const voiceFileId =
    typeof message.voice?.file_id === "string" ? message.voice.file_id.trim() : "";
  if (voiceFileId) {
    return {
      fileId: voiceFileId,
      fileName: sanitizeFileName(
        buildIncomingFileName({
          base: "voice",
          messageId,
          mimeType:
            typeof message.voice?.mime_type === "string"
              ? message.voice.mime_type
              : undefined,
        })
      ),
    };
  }

  return null;
}

async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
  const payload = await callTelegramApi(botToken, "getFile", {
    file_id: fileId,
  });
  const result = payload.result ?? {};
  const filePath = typeof result.file_path === "string" ? result.file_path : "";
  if (!filePath) {
    throw new Error("Telegram getFile returned empty file_path");
  }

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file (${response.status})`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > TELEGRAM_FILE_MAX_BYTES) {
    throw new Error(
      `Telegram file is too large (${bytes.byteLength} bytes). Max supported size is ${TELEGRAM_FILE_MAX_BYTES} bytes.`
    );
  }
  return Buffer.from(bytes);
}

function extractCommand(text: string): string | null {
  const first = text.trim().split(/\s+/, 1)[0];
  if (!first || !first.startsWith("/")) return null;
  return first.split("@", 1)[0].toLowerCase();
}

function extractAccessCodeCandidate(text: string): string | null {
  const value = text.trim();
  if (!value) return null;

  const fromCommand = value.match(
    /^\/(?:code|start)(?:@[a-zA-Z0-9_]+)?\s+([A-Za-z0-9_-]{6,64})$/i
  );
  if (fromCommand?.[1]) {
    return fromCommand[1];
  }

  if (/^[A-Za-z0-9_-]{6,64}$/.test(value)) {
    return value;
  }
  return null;
}

function normalizeOutgoingText(text: string): string {
  const value = text.trim();
  if (!value) return "Пустой ответ от агента.";
  if (value.length <= TELEGRAM_TEXT_LIMIT) return value;
  return `${value.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: normalizeOutgoingText(text),
      ...(typeof replyToMessageId === "number" ? { reply_to_message_id: replyToMessageId } : {}),
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; description?: string }
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      `Telegram sendMessage failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`
    );
  }
}

function helpText(activeProject?: { id?: string; name?: string }): string {
  const activeProjectLine = activeProject?.id
    ? `Active project: ${activeProject.name ? `${activeProject.name} (${activeProject.id})` : activeProject.id}`
    : "Active project: not selected";
  return [
    "Telegram connection is active.",
    activeProjectLine,
    "",
    "Commands:",
    "/start - show this help",
    "/help - show this help",
    "/code <access_code> - activate access for your Telegram user",
    "/new - start a new conversation (reset context)",
    "",
    "Text messages are sent to the agent.",
    "File uploads are saved into chat files.",
    "You can also ask the agent to send a local file back to Telegram.",
  ].join("\n");
}

export const maxDuration = 300;

export async function GET() {
  return Response.json({
    status: "ok",
    integration: "telegram",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  const runtime = await getTelegramIntegrationRuntimeConfig();
  const botToken = runtime.botToken.trim();
  const webhookSecret = runtime.webhookSecret.trim();
  const defaultProjectId = runtime.defaultProjectId || undefined;
  const allowedUserIds = new Set(runtime.allowedUserIds);

  if (!botToken || !webhookSecret) {
    return Response.json(
      {
        error:
          "Telegram integration is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.",
      },
      { status: 503 }
    );
  }

  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (!providedSecret || !safeTokenMatch(providedSecret, webhookSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let botIdForRollback: string | null = null;
  let updateIdForRollback: number | null = null;

  try {
    const body = (await req.json()) as TelegramUpdate;
    const updateId =
      typeof body.update_id === "number" && Number.isInteger(body.update_id)
        ? body.update_id
        : null;
    if (updateId === null) {
      return Response.json({ error: "Invalid update_id" }, { status: 400 });
    }

    const botId = getBotId(botToken);
    botIdForRollback = botId;
    updateIdForRollback = updateId;
    const isNewUpdate = await claimTelegramUpdate(botId, updateId);
    if (!isNewUpdate) {
      return Response.json({ ok: true, duplicate: true });
    }

    const message = body.message;
    const chatId =
      typeof message?.chat?.id === "number" || typeof message?.chat?.id === "string"
        ? message.chat.id
        : null;
    const chatType = typeof message?.chat?.type === "string" ? message.chat.type : "";
    const messageId =
      typeof message?.message_id === "number" ? message.message_id : undefined;

    if (chatId === null || !chatType) {
      return Response.json({ ok: true, ignored: true, reason: "unsupported_update" });
    }

    if (chatType !== "private") {
      return Response.json({ ok: true, ignored: true, reason: "private_only" });
    }

    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const caption =
      typeof message?.caption === "string" ? message.caption.trim() : "";
    const incomingText = text || caption;
    const fromUserId = normalizeTelegramUserId(message?.from?.id);

    if (!fromUserId) {
      return Response.json({
        ok: true,
        ignored: true,
        reason: "missing_user_id",
      });
    }

    if (!allowedUserIds.has(fromUserId)) {
      const accessCode = extractAccessCodeCandidate(text);
      const granted =
        accessCode &&
        (await consumeTelegramAccessCode({
          code: accessCode,
          userId: fromUserId,
        }));

      if (granted) {
        await sendTelegramMessage(
          botToken,
          chatId,
          "Доступ выдан. Теперь можно отправлять сообщения агенту.",
          messageId
        );
        return Response.json({
          ok: true,
          accessGranted: true,
          userId: fromUserId,
        });
      }

      await sendTelegramMessage(
        botToken,
        chatId,
        [
          "Доступ запрещён: ваш user_id не в списке разрешённых.",
          "Отправьте код активации командой /code <код> или /start <код>.",
          `Ваш user_id: ${fromUserId}`,
        ].join("\n"),
        messageId
      );
      return Response.json({
        ok: true,
        ignored: true,
        reason: "user_not_allowed",
        userId: fromUserId,
      });
    }

    let sessionId = await getTelegramChatSessionId(botId, chatId);
    if (!sessionId) {
      sessionId = createDefaultTelegramSessionId(botId, chatId);
      await setTelegramChatSessionId(botId, chatId, sessionId);
    }

    const command = extractCommand(text);
    if (command === "/start" || command === "/help") {
      const resolvedProject = await resolveTelegramProjectContext({
        sessionId,
        defaultProjectId,
      });
      await saveExternalSession({
        ...resolvedProject.session,
        updatedAt: new Date().toISOString(),
      });
      await sendTelegramMessage(
        botToken,
        chatId,
        helpText({
          id: resolvedProject.resolvedProjectId,
          name: resolvedProject.projectName,
        }),
        messageId
      );
      return Response.json({ ok: true, command });
    }

    if (command === "/new") {
      const freshSessionId = createFreshTelegramSessionId(botId, chatId);
      await setTelegramChatSessionId(botId, chatId, freshSessionId);
      await sendTelegramMessage(
        botToken,
        chatId,
        "Начал новый диалог. Контекст очищен для следующего сообщения.",
        messageId
      );
      return Response.json({ ok: true, command });
    }

    let incomingSavedFile:
      | {
          name: string;
          path: string;
          size: number;
        }
      | null = null;

    const incomingFile = message ? extractIncomingFile(message, messageId) : null;
    let externalContext: TelegramExternalChatContext | null = null;
    if (incomingFile) {
      externalContext = await ensureTelegramExternalChatContext({
        sessionId,
        defaultProjectId,
      });
      const fileBuffer = await downloadTelegramFile(botToken, incomingFile.fileId);
      const saved = await saveChatFile(
        externalContext.chatId,
        fileBuffer,
        incomingFile.fileName
      );
      incomingSavedFile = {
        name: saved.name,
        path: saved.path,
        size: saved.size,
      };
    }

    if (!incomingText) {
      if (incomingSavedFile) {
        await sendTelegramMessage(
          botToken,
          chatId,
          `File "${incomingSavedFile.name}" saved to chat files.`,
          messageId
        );
        return Response.json({
          ok: true,
          fileSaved: true,
          file: incomingSavedFile,
        });
      }

      await sendTelegramMessage(
        botToken,
        chatId,
        "Only text messages and file uploads are supported right now.",
        messageId
      );
      return Response.json({ ok: true, ignored: true, reason: "non_text" });
    }

    try {
      const result = await handleExternalMessage({
        sessionId,
        message: incomingSavedFile
          ? `${incomingText}\n\nAttached file: ${incomingSavedFile.name}`
          : incomingText,
        projectId: externalContext?.projectId ?? defaultProjectId,
        chatId: externalContext?.chatId,
        currentPath: normalizeTelegramCurrentPath(externalContext?.currentPath),
        runtimeData: {
          telegram: {
            botToken,
            chatId,
            replyToMessageId: messageId ?? null,
          },
        },
      });

      await sendTelegramMessage(botToken, chatId, result.reply, messageId);
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof ExternalMessageError) {
        const errorMessage =
          typeof error.payload.error === "string"
            ? error.payload.error
            : "Не удалось обработать сообщение.";
        await sendTelegramMessage(botToken, chatId, `Ошибка: ${errorMessage}`, messageId);
        return Response.json({ ok: true, handledError: true, status: error.status });
      }
      throw error;
    }
  } catch (error) {
    if (
      botIdForRollback &&
      typeof updateIdForRollback === "number" &&
      Number.isInteger(updateIdForRollback)
    ) {
      try {
        await releaseTelegramUpdate(botIdForRollback, updateIdForRollback);
      } catch (releaseError) {
        console.error("Telegram rollback error:", releaseError);
      }
    }

    console.error("Telegram webhook error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
