import {
    handleExternalMessage,
    ExternalMessageError,
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
} from "@/lib/storage/external-session-store";
import { getAllProjects } from "@/lib/storage/project-store";
import { transcribeAudioFile } from "@/lib/speech/transcriber";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey, MessageValues } from "@/i18n/messages";
import crypto from "node:crypto";

// Leave headroom under Telegram's hard 4096 limit: HTML escaping expands the payload
// (`&` becomes `&amp;`) and each chunk may gain a reopened code fence.
const TELEGRAM_CHUNK_LIMIT = 3500;
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

function splitOverlongLine(line: string, limit: number): string[] {
    if (line.length <= limit) return [line];
    const pieces: string[] = [];
    for (let index = 0; index < line.length; index += limit) {
        pieces.push(line.slice(index, index + limit));
    }
    return pieces;
}

/**
 * Split raw markdown into Telegram-sized chunks *before* it is rendered to HTML.
 *
 * Splitting after rendering can cut a message in the middle of a tag, which makes
 * Telegram reject the whole message with "Can't find end tag corresponding to
 * start tag". Fenced code blocks that straddle a boundary are closed at the end
 * of one chunk and reopened at the start of the next.
 */
export function splitTelegramMarkdown(text: string): string[] {
    const chunks: string[] = [];
    let buffer: string[] = [];
    let bufferLength = 0;
    let openFence: string | null = null;

    const flush = () => {
        if (!buffer.length) return;
        const parts = [...buffer];
        if (openFence !== null) parts.push("```");
        const chunk = parts.join("\n").trim();
        if (chunk && chunk !== "```") chunks.push(chunk);
        buffer = [];
        bufferLength = 0;
        if (openFence !== null) {
            const reopened = `\`\`\`${openFence}`;
            buffer.push(reopened);
            bufferLength = reopened.length + 1;
        }
    };

    for (const rawLine of text.split("\n")) {
        for (const line of splitOverlongLine(rawLine, TELEGRAM_CHUNK_LIMIT)) {
            if (bufferLength + line.length + 1 > TELEGRAM_CHUNK_LIMIT) flush();
            buffer.push(line);
            bufferLength += line.length + 1;

            const fence = /^```(.*)$/.exec(line.trim());
            if (fence) {
                openFence = openFence === null ? (fence[1] || "") : null;
            }
        }
    }

    flush();
    return chunks;
}

/**
 * Which project this chat is in, shown under the input field.
 *
 * Two messages after switching, the project is off the top of the screen and
 * the only way to find out was to ask - so the answer sits where it cannot
 * scroll away. In the workspace scope there is no button at all: the common
 * case stays uncluttered, and the button's presence is itself the signal.
 *
 * Derived from the session on every send rather than toggled when the project
 * changes. A keyboard set by an event drifts the moment anything else moves the
 * session - a container recreate, a project deleted while the user was inside
 * it, a switch made from the web UI - and a stale indicator is worse than none.
 * Computing it each time costs nothing: it rides on a request already going out.
 */
function projectKeyboard(
    projectName: string | null | undefined,
    t: (key: MessageKey, values?: MessageValues) => string
): Record<string, unknown> {
    if (!projectName) return { remove_keyboard: true };
    const label = t("telegram.bot.exitProject", { project: truncateProjectLabel(projectName) });
    return {
        keyboard: [[{ text: label }]],
        is_persistent: true,
        resize_keyboard: true,
        one_time_keyboard: false,
    };
}

/** Long names wrap onto a second line on a phone and push the input field down. */
function truncateProjectLabel(name: string): string {
    const trimmed = name.trim();
    return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 23)}…`;
}

async function callTelegramSendMessage(params: {
    botToken: string;
    chatId: number | string;
    text: string;
    parseMode: "HTML" | null;
    replyToMessageId?: number;
    replyMarkup?: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; description?: string }> {
    const response = await fetch(`https://api.telegram.org/bot${params.botToken}/sendMessage`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            chat_id: params.chatId,
            text: params.text,
            ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
            ...(typeof params.replyToMessageId === "number"
                ? { reply_to_message_id: params.replyToMessageId }
                : {}),
            ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
        }),
    });

    const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string }
        | null;

    return {
        ok: response.ok && Boolean(payload?.ok),
        status: response.status,
        description: payload?.description,
    };
}

function escapeTelegramHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
    return escapeTelegramHtml(text).replaceAll('"', "&quot;");
}

function renderInlineTelegramMarkdown(text: string): string {
    const placeholders: string[] = [];
    const withCode = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
        const token = `\u0000${placeholders.length}\u0000`;
        placeholders.push(`<code>${escapeTelegramHtml(code)}</code>`);
        return token;
    });

    let rendered = escapeTelegramHtml(withCode)
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/__([^_\n]+)__/g, "<b>$1</b>")
        .replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
            return `<a href="${escapeTelegramHtmlAttribute(url)}">${label}</a>`;
        });

    for (let index = 0; index < placeholders.length; index += 1) {
        rendered = rendered.replaceAll(`\u0000${index}\u0000`, placeholders[index]);
    }
    return rendered;
}

function markdownToTelegramHtml(text: string): string {
    const parts = text.split(/```/);
    return parts
        .map((part, index) => {
            if (index % 2 === 1) {
                const code = part.replace(/^\w+\n/, "");
                return `<pre>${escapeTelegramHtml(code.trim())}</pre>`;
            }
            return renderInlineTelegramMarkdown(part);
        })
        .join("");
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
): Promise<void> {
    const normalized = normalizeOutgoingText(text, t || ((key) => key));
    const chunks = splitTelegramMarkdown(normalized);
    if (!chunks.length) return;

    let isFirstChunk = true;
    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const replyTo = isFirstChunk ? replyToMessageId : undefined;
        isFirstChunk = false;
        const markup = index === chunks.length - 1 ? replyMarkup : undefined;

        const rendered = await callTelegramSendMessage({
            botToken,
            chatId,
            text: markdownToTelegramHtml(chunk),
            parseMode: "HTML",
            replyToMessageId: replyTo,
            replyMarkup: markup,
        });
        if (rendered.ok) continue;

        // Telegram rejected the rendered markup. Retry this chunk as plain text so
        // the user still receives the content instead of silence.
        console.warn(
            `[Telegram] Falling back to plain text (${rendered.status})${rendered.description ? `: ${rendered.description}` : ""}`
        );
        const plain = await callTelegramSendMessage({
            botToken,
            chatId,
            text: chunk,
            parseMode: null,
            replyToMessageId: replyTo,
            replyMarkup: markup,
        });
        if (!plain.ok) {
            throw new Error(
                `Telegram sendMessage failed (${plain.status})${plain.description ? `: ${plain.description}` : ""}`
            );
        }
    }
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

    const botId = getBotId(botToken);
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
                    const transcription = await transcribeAudioFile({
                        filePath: saved.path,
                        filename: saved.name,
                        mimeType:
                            typeof message?.voice?.mime_type === "string"
                                ? message.voice.mime_type
                                : "audio/ogg",
                    });
                    transcribedVoiceText = transcription.transcript;
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
                        file: incomingSavedFile,
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

        const stopProgressNotifier = startTelegramProgressNotifier({
            botToken,
            chatId,
            replyToMessageId: messageId,
            t,
        });

        try {
            const result = await handleExternalMessage({
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
            });

            stopProgressNotifier();
            await sendTelegramMessage(
                botToken,
                chatId,
                result.reply,
                messageId,
                t,
                projectKeyboard(result.context.activeProjectName, t)
            );
            return { ok: true };
        } catch (error) {
            stopProgressNotifier();
            if (error instanceof ExternalMessageError) {
                const errorMessage =
                    typeof error.payload.error === "string"
                        ? error.payload.error
                        : t("telegram.bot.processingFailed");
                await sendTelegramMessage(botToken, chatId, t("telegram.bot.errorPrefix", { error: errorMessage }), messageId, t);
                return { ok: true, handledError: true, status: error.status };
            }
            throw error;
        }
    } catch (error) {
        await releaseTelegramUpdate(botId, updateId);
        throw error;
    }
}
