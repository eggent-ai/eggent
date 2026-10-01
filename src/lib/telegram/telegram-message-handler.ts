import {
    handleExternalMessage,
    ExternalMessageError,
    isChatCommand,
} from "@/lib/external/handle-external-message";
import { agentFailureText } from "@/lib/telegram/failure-reply";
import { startDraftStream, toolActivity, type DraftActivity } from "@/lib/telegram/draft-stream";
import { markdownToTelegramHtml, projectKeyboard, sendTelegramMarkdown, withChatFooter } from "@/lib/telegram/format";
import {
    bindTelegramSession,
    chatForTelegramMessage,
    recordTelegramMessages,
    telegramBotId,
    telegramBotKey,
} from "@/lib/telegram/conversation";
import { redactSecrets } from "@/lib/pi/provider-failure";
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
    normalizeTelegramUserId,
    type TelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import { saveChatFile } from "@/lib/storage/chat-files-store";
import { createChat, getChat } from "@/lib/storage/chat-store";
import {
    contextKey,
    type ExternalSession,
    getOrCreateExternalSession,
    saveExternalSession,
    sessionChatId,
    setSessionChatId,
} from "@/lib/storage/external-session-store";
import { getAllProjects } from "@/lib/storage/project-store";
import { transcribeVoiceNote } from "@/lib/speech/voice-note";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";
import crypto from "node:crypto";

// The draft's line for each kind of running tool, in the workspace's language.
const DRAFT_ACTIVITY_KEYS: Record<DraftActivity, MessageKey> = {
    search: "telegram.bot.draft.search",
    page: "telegram.bot.draft.page",
    files: "telegram.bot.draft.files",
    command: "telegram.bot.draft.command",
    helper: "telegram.bot.draft.helper",
    service: "telegram.bot.draft.service",
    image: "telegram.bot.draft.image",
    send: "telegram.bot.draft.send",
    work: "telegram.bot.draft.work",
};

const TELEGRAM_FILE_MAX_BYTES = 30 * 1024 * 1024;
const TELEGRAM_TYPING_INTERVAL_MS = 4000;
const TELEGRAM_PROGRESS_MESSAGES: Array<{ delayMs: number; key: MessageKey }> = [
    { delayMs: 12_000, key: "telegram.bot.progress.short" },
    { delayMs: 35_000, key: "telegram.bot.progress.medium" },
    { delayMs: 75_000, key: "telegram.bot.progress.long" },
];
// After the scripted messages run out, keep a heartbeat going so a long task
// never leaves the chat silent for more than this interval.
const TELEGRAM_PROGRESS_HEARTBEAT_MS = 45_000;
const TELEGRAM_PROGRESS_HEARTBEAT_MAX = 12;

export interface TelegramUpdate {
    update_id?: unknown;
    message?: TelegramMessage;
}

export interface TelegramMessage {
    message_id?: unknown;
    text?: unknown;
    caption?: unknown;
    reply_to_message?: {
        message_id?: unknown;
        text?: unknown;
        caption?: unknown;
    };
    from?: {
        id?: unknown;
        language_code?: unknown;
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
        duration?: unknown;
    };
}

interface TelegramApiResponse {
    ok?: boolean;
    description?: string;
    result?: Record<string, unknown>;
}

interface TelegramFileResult {
    file_id?: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
}

export interface TelegramIncomingFile {
    fileId: string;
    fileName: string;
}

export interface TelegramExternalChatContext {
    chatId: string;
    projectId?: string;
    currentPath: string;
}

interface TelegramResolvedProjectContext {
    session: ExternalSession;
    resolvedProjectId?: string;
    projectName?: string;
}

export interface ProcessTelegramUpdateResult {
    ok: boolean;
    duplicate?: boolean;
    ignored?: boolean;
    reason?: string;
    command?: string;
    accessGranted?: boolean;
    userId?: string;
    fileSaved?: boolean;
    file?: {
        name: string;
        path: string;
        size: number;
    };
    handledError?: boolean;
    status?: number;
}

function normalizeTelegramCurrentPath(rawPath: string | undefined): string {
    const value = (rawPath ?? "").trim();
    if (!value || value === "/telegram") {
        return "";
    }
    return value;
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

async function ensureTelegramExternalChatContext(params: {
    sessionId: string;
    defaultProjectId?: string;
}): Promise<TelegramExternalChatContext> {
    const { session, resolvedProjectId } = await resolveTelegramProjectContext({
        sessionId: params.sessionId,
        defaultProjectId: params.defaultProjectId,
    });
    const projectKey = contextKey(resolvedProjectId);
    // The conversation follows the person, not the project: whichever project
    // the agent has moved into, this is still the same thread they are having.
    // The chat keeps the project it was created under; only the runtime's
    // working directory follows the switch.
    let resolvedChatId = sessionChatId(session) ?? "";
    if (resolvedChatId && !(await getChat(resolvedChatId))) {
        resolvedChatId = "";
    }

    if (!resolvedChatId) {
        resolvedChatId = crypto.randomUUID();
        await createChat(
            resolvedChatId,
            `External session ${session.id}`,
            resolvedProjectId
        );
    }

    setSessionChatId(session, resolvedChatId);
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
            const t = await getServerTranslator();
            throw new Error(t("telegram.bot.projectNotFound", { project: explicitProjectId }));
        }
        resolvedProjectId = explicitProjectId;
        session.activeProjectId = explicitProjectId;
    } else if (session.activeProjectId && projectById.has(session.activeProjectId)) {
        resolvedProjectId = session.activeProjectId;
    } else {
        // No project asked for and none remembered, so the session stays in the
        // workspace scope. This used to fall through to projects[0] and persist
        // it, which made a session's project depend on which path the message
        // took: plain text resolved one way and an attachment - or /start - the
        // other. Sending a photo could silently bind the session to whichever
        // project happened to sort first, and that choice then stuck for every
        // message after it. Reported as #20 by @nimph977.
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

export function extractIncomingFile(
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

export async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
    const payload = await callTelegramApi(botToken, "getFile", {
        file_id: fileId,
    });
    const result = payload.result as TelegramFileResult | undefined;
    const filePath = result?.file_path ?? "";
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

function normalizeOutgoingText(text: string, t: (key: MessageKey) => string): string {
    return text.trim() || t("telegram.bot.emptyAgentReply");
}

export async function sendTelegramChatAction(
    botToken: string,
    chatId: number | string,
    action: "typing" | "upload_document" = "typing"
): Promise<void> {
    await callTelegramApi(botToken, "sendChatAction", {
        chat_id: chatId,
        action,
    });
}

function startTelegramProgressNotifier(params: {
    botToken: string;
    chatId: number | string;
    replyToMessageId?: number;
    t: (key: MessageKey) => string;
}): () => void {
    let stopped = false;
    const timers: NodeJS.Timeout[] = [];

    const safeSendChatAction = () => {
        if (stopped) return;
        void sendTelegramChatAction(params.botToken, params.chatId).catch((error) => {
            console.warn("[Telegram] Failed to send chat action:", error);
        });
    };

    const sendProgress = (key: MessageKey) => {
        if (stopped) return;
        void sendTelegramMessage(
            params.botToken,
            params.chatId,
            params.t(key),
            params.replyToMessageId
        ).catch((error) => {
            console.warn("[Telegram] Failed to send progress message:", error);
        });
    };

    safeSendChatAction();
    timers.push(setInterval(safeSendChatAction, TELEGRAM_TYPING_INTERVAL_MS));

    for (const progress of TELEGRAM_PROGRESS_MESSAGES) {
        timers.push(setTimeout(() => sendProgress(progress.key), progress.delayMs));
    }

    // Keep reassuring the user after the scripted messages are exhausted: p90 of
    // real replies lands well past the last scripted message, and silence there
    // reads as "the bot is dead".
    const lastScriptedDelay = TELEGRAM_PROGRESS_MESSAGES.length
        ? TELEGRAM_PROGRESS_MESSAGES[TELEGRAM_PROGRESS_MESSAGES.length - 1].delayMs
        : 0;
    let heartbeats = 0;
    const beat = () => {
        if (stopped || heartbeats >= TELEGRAM_PROGRESS_HEARTBEAT_MAX) return;
        heartbeats += 1;
        sendProgress("telegram.bot.progress.long");
    };
    timers.push(setTimeout(() => {
        if (stopped) return;
        // Send immediately, then keep the same cadence, so the gap after the last
        // scripted message is never longer than the heartbeat interval itself.
        beat();
        timers.push(setInterval(beat, TELEGRAM_PROGRESS_HEARTBEAT_MS));
    }, lastScriptedDelay + TELEGRAM_PROGRESS_HEARTBEAT_MS));

    return () => {
        stopped = true;
        for (const timer of timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
    };
}

export async function sendTelegramMessage(
    botToken: string,
    chatId: number | string,
    text: string,
    replyToMessageId?: number,
    t?: (key: MessageKey) => string,
    // Rides on the last chunk only: Telegram keeps the most recent keyboard, so
    // repeating it on every piece of a long answer would redraw it needlessly.
    replyMarkup?: Record<string, unknown>
): Promise<number[]> {
    return sendTelegramMarkdown({
        botToken,
        chatId,
        text: normalizeOutgoingText(text, t || ((key) => key)),
        replyToMessageId,
        replyMarkup,
    });
}

function helpText(t: (key: MessageKey, values?: Record<string, string | number | boolean | null | undefined>) => string, activeProject?: { id?: string; name?: string }): string {
    const projectLabel = activeProject?.id
        ? (activeProject.name ? `${activeProject.name} (${activeProject.id})` : activeProject.id)
        : t("telegram.bot.help.noProject");
    return [
        t("telegram.bot.help.connected"),
        t("telegram.bot.help.activeProject", { project: projectLabel }),
        "",
        t("telegram.bot.help.commands"),
        t("telegram.bot.help.start"),
        t("telegram.bot.help.help"),
        t("telegram.bot.help.code"),
        t("telegram.bot.help.new"),
        t("telegram.bot.help.chats"),
        "",
        t("telegram.bot.help.text"),
        t("telegram.bot.help.voice"),
        t("telegram.bot.help.files"),
        t("telegram.bot.help.sendBack"),
    ].join("\n");
}

export async function processTelegramUpdate(
    update: TelegramUpdate,
    runtime: TelegramIntegrationRuntimeConfig
): Promise<ProcessTelegramUpdateResult> {
    const botToken = runtime.botToken.trim();
    const defaultProjectId = runtime.defaultProjectId || undefined;
    const allowedUserIds = new Set(runtime.allowedUserIds);

    if (!botToken) {
        throw new Error("Telegram bot token is not configured");
    }

    const updateId =
        typeof update.update_id === "number" && Number.isInteger(update.update_id)
            ? update.update_id
            : null;
    if (updateId === null) {
        throw new Error("Invalid update_id");
    }

    const botId = telegramBotId(botToken);
    const isNewUpdate = await claimTelegramUpdate(botId, updateId);
    if (!isNewUpdate) {
        return { ok: true, duplicate: true };
    }

    try {
        const message = update.message;
        const chatId =
            typeof message?.chat?.id === "number" || typeof message?.chat?.id === "string"
                ? message.chat.id
                : null;
        const chatType = typeof message?.chat?.type === "string" ? message.chat.type : "";
        const messageId =
            typeof message?.message_id === "number" ? message.message_id : undefined;

        if (chatId === null || !chatType) {
            return { ok: true, ignored: true, reason: "unsupported_update" };
        }

        if (chatType !== "private") {
            return { ok: true, ignored: true, reason: "private_only" };
        }

        const t = await getServerTranslator(typeof message?.from?.language_code === "string" ? message.from.language_code : undefined);
        const text = typeof message?.text === "string" ? message.text.trim() : "";
        const caption =
            typeof message?.caption === "string" ? message.caption.trim() : "";
        const incomingText = text || caption;
        const fromUserId = normalizeTelegramUserId(message?.from?.id);

        if (!fromUserId) {
            return {
                ok: true,
                ignored: true,
                reason: "missing_user_id",
            };
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
                    t("telegram.bot.accessGranted"),
                    messageId,
                    t
                );
                return {
                    ok: true,
                    accessGranted: true,
                    userId: fromUserId,
                };
            }

            await sendTelegramMessage(
                botToken,
                chatId,
                [
                    t("telegram.bot.greeting"),
                    t("telegram.bot.needAccess"),
                    t("telegram.bot.sendCode"),
                    t("telegram.bot.yourUserId", { userId: fromUserId }),
                ].join("\n"),
                messageId,
                t
            );
            return {
                ok: true,
                ignored: true,
                reason: "user_not_allowed",
                userId: fromUserId,
            };
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
                helpText(t, {
                    id: resolvedProject.resolvedProjectId,
                    name: resolvedProject.projectName,
                }),
                messageId,
                t,
                // /start is also how someone gets the indicator back after
                // hiding the keyboard, so it is redrawn from the session here.
                projectKeyboard(resolvedProject.projectName, t)
            );
            return { ok: true, command };
        }

        if (command === "/new") {
            const freshSessionId = createFreshTelegramSessionId(botId, chatId);
            await setTelegramChatSessionId(botId, chatId, freshSessionId);
            await sendTelegramMessage(
                botToken,
                chatId,
                t("telegram.bot.newChat"),
                messageId,
                t
            );
            return { ok: true, command };
        }

        // A reply continues the chat the replied-to message came from. Moved
        // before anything is saved, so a file sent as a reply lands there too.
        const botKey = telegramBotKey(botToken);
        const previousChatId = sessionChatId(await getOrCreateExternalSession(sessionId));
        const repliedTo = message?.reply_to_message;
        const repliedToMessageId =
            typeof repliedTo?.message_id === "number" ? repliedTo.message_id : undefined;
        if (repliedToMessageId !== undefined) {
            const replyChatId = await chatForTelegramMessage({
                botKey,
                telegramChatId: chatId,
                messageId: repliedToMessageId,
            });
            if (replyChatId) await bindTelegramSession(sessionId, replyChatId);
        }
        // What was replied to, so "this" in the reply has something to point at.
        const repliedToText = typeof repliedTo?.text === "string"
            ? repliedTo.text
            : typeof repliedTo?.caption === "string" ? repliedTo.caption : "";

        let incomingSavedFile: {
            name: string;
            path: string;
            size: number;
        } | null = null;
        let transcribedVoiceText = "";

        const incomingFile = message ? extractIncomingFile(message, messageId) : null;
        const isVoiceMessage = Boolean(message?.voice?.file_id);
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

            if (isVoiceMessage) {
                await sendTelegramChatAction(botToken, chatId).catch(() => undefined);
                await sendTelegramMessage(
                    botToken,
                    chatId,
                    t("telegram.bot.transcribingVoice"),
                    messageId,
                    t
                );
                try {
                    transcribedVoiceText = await transcribeVoiceNote({
                        chatId: externalContext.chatId,
                        filePath: saved.path,
                        savedName: saved.name,
                        mimeType:
                            typeof message?.voice?.mime_type === "string"
                                ? message.voice.mime_type
                                : "audio/ogg",
                    });
                    // The recording is gone with the transcript; nothing to report.
                    incomingSavedFile = null;
                } catch (error) {
                    await sendTelegramMessage(
                        botToken,
                        chatId,
                        t("telegram.bot.voiceTranscriptionFailed", { error: error instanceof Error ? error.message : "unknown error" }),
                        messageId,
                        t
                    );
                    return {
                        ok: true,
                        handledError: true,
                        fileSaved: true,
                        file: incomingSavedFile ?? undefined,
                    };
                }
            }
        }

        const effectiveIncomingText = transcribedVoiceText
            ? [
                incomingText ? t("telegram.bot.voiceComment", { text: incomingText }) : "",
                t("telegram.bot.voiceMessage", { text: transcribedVoiceText }),
            ].filter(Boolean).join("\n\n")
            : incomingText;

        if (!effectiveIncomingText) {
            if (incomingSavedFile) {
                await sendTelegramMessage(
                    botToken,
                    chatId,
                    t("telegram.bot.fileSaved", { name: incomingSavedFile.name }),
                    messageId,
                    t
                );
                return {
                    ok: true,
                    fileSaved: true,
                    file: incomingSavedFile,
                };
            }

            await sendTelegramMessage(
                botToken,
                chatId,
                t("telegram.bot.unsupported"),
                messageId,
                t
            );
            return { ok: true, ignored: true, reason: "non_text" };
        }

        // The answer is written into a draft as it arrives. The old indicator -
        // typing, then separate "still working" messages that stayed in the chat
        // - runs only where Telegram refuses drafts.
        const fallbackNotifier: { stop?: () => void } = {};
        // /chats and /c_ are answered without the model, at once; a "Thinking…"
        // draft there would only flicker.
        const draft = isChatCommand(effectiveIncomingText) ? { onProgress: () => {}, stop: async () => {} } : startDraftStream({
            chatId,
            send: (body) => callTelegramApi(botToken, "sendMessageDraft", body),
            format: markdownToTelegramHtml,
            status: {
                thinking: t("telegram.bot.draft.thinking"),
                tool: (name) => t(DRAFT_ACTIVITY_KEYS[toolActivity(name)]),
                helpers: (running, total) => t("telegram.bot.draft.helpers", { running, total }),
            },
            onUnavailable: () => {
                fallbackNotifier.stop = startTelegramProgressNotifier({
                    botToken,
                    chatId,
                    replyToMessageId: messageId,
                    t,
                });
            },
        });
        const stopProgressNotifier = async () => {
            await draft.stop();
            fallbackNotifier.stop?.();
        };

        let result: Awaited<ReturnType<typeof handleExternalMessage>>;
        try {
            result = await handleExternalMessage({
                sessionId,
                message: incomingSavedFile && !isVoiceMessage
                    ? `${effectiveIncomingText}\n\n${t("telegram.bot.attachedFile", { name: incomingSavedFile.name })}`
                    : effectiveIncomingText,
                projectId: externalContext?.projectId ?? defaultProjectId,
                chatId: externalContext?.chatId,
                currentPath: normalizeTelegramCurrentPath(externalContext?.currentPath),
                runtimeData: {
                    telegram: {
                        chatId,
                        replyToMessageId: messageId ?? null,
                        ...(repliedToText.trim()
                            ? { inReplyTo: repliedToText.trim().slice(0, 500) }
                            : {}),
                    },
                },
                toolRuntimeData: {
                    telegram: {
                        botToken,
                        chatId,
                        replyToMessageId: messageId ?? null,
                    },
                },
                telegramVia: "workspace-bot",
                telegramBotKey: botKey,
                previousChatId,
                onProgress: (event) => draft.onProgress(event),
            });
        } catch (error) {
            await stopProgressNotifier();
            // A turn that failed is answered once, and the update counts as
            // handled. Rethrowing here made polling run the whole turn twice
            // more and then drop the update, and made a webhook answer 500 so
            // Telegram delivered it again - each time through the same broken
            // model, while the person heard nothing (issue #26). Only failing
            // to reach Telegram itself, below, is still worth a retry.
            const structured = error instanceof ExternalMessageError;
            if (!structured) {
                console.error(
                    "[Telegram] Turn failed:",
                    redactSecrets(error instanceof Error ? error.message : String(error))
                );
            }
            const fallback = t("telegram.bot.processingFailed");
            const errorMessage = structured
                ? agentFailureText(typeof error.payload.error === "string" ? error.payload.error : "", fallback)
                : agentFailureText(error, fallback);
            await sendTelegramMessage(botToken, chatId, t("telegram.bot.errorPrefix", { error: errorMessage }), messageId, t);
            return { ok: true, handledError: true, status: structured ? error.status : 500 };
        }

        await stopProgressNotifier();
        const sentIds = await sendTelegramMessage(
            botToken,
            chatId,
            // When the conversation moved, the answer says where to: the
            // person has no chat list to look at.
            result.chatChanged ? withChatFooter(result.reply, result.context.activeChatTitle) : result.reply,
            messageId,
            t,
            projectKeyboard(result.context.activeProjectName, t)
        );
        await recordTelegramMessages({
            botKey,
            telegramChatId: chatId,
            messageIds: sentIds,
            chatId: result.context.activeChatId,
        });
        return { ok: true };
    } catch (error) {
        await releaseTelegramUpdate(botId, updateId);
        throw error;
    }
}
