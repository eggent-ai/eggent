import type { MessageKey, MessageValues } from "@/i18n/messages";

/**
 * The agent writes markdown; Telegram reads its own small HTML dialect.
 *
 * Shared by the answers this workspace's bot sends and by results delivered
 * later, such as a scheduled run's: both are the agent speaking, and a report
 * arriving with literal asterisks where the answer an hour earlier had bold
 * text reads as something broken.
 */

// Leave headroom under Telegram's hard 4096 limit: HTML escaping expands the payload
// (`&` becomes `&amp;`) and each chunk may gain a reopened code fence.
const TELEGRAM_CHUNK_LIMIT = 3500;

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

export function markdownToTelegramHtml(text: string): string {
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

async function callTelegramSendMessage(params: {
    botToken: string;
    chatId: number | string;
    text: string;
    parseMode: "HTML" | null;
    replyToMessageId?: number;
    replyMarkup?: Record<string, unknown>;
}): Promise<{ ok: boolean; status: number; description?: string; messageId?: number }> {
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
        | { ok?: boolean; description?: string; result?: { message_id?: unknown } }
        | null;

    return {
        ok: response.ok && Boolean(payload?.ok),
        status: response.status,
        description: payload?.description,
        messageId: typeof payload?.result?.message_id === "number" ? payload.result.message_id : undefined,
    };
}

/**
 * Send markdown as one or more Telegram messages, and say which ones.
 *
 * Each chunk falls back to plain text when Telegram refuses the rendered
 * markup, so the person gets the content rather than silence. The ids are what
 * lets a reply to any of these messages find its way back to the chat that
 * wrote it. Throws when Telegram refuses a chunk outright.
 */
export async function sendTelegramMarkdown(params: {
    botToken: string;
    chatId: number | string;
    text: string;
    replyToMessageId?: number;
    // Rides on the last chunk only: Telegram keeps the most recent keyboard, so
    // repeating it on every piece of a long answer would redraw it needlessly.
    replyMarkup?: Record<string, unknown>;
}): Promise<number[]> {
    const chunks = splitTelegramMarkdown(params.text);
    const messageIds: number[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const replyTo = index === 0 ? params.replyToMessageId : undefined;
        const markup = index === chunks.length - 1 ? params.replyMarkup : undefined;

        const rendered = await callTelegramSendMessage({
            botToken: params.botToken,
            chatId: params.chatId,
            text: markdownToTelegramHtml(chunk),
            parseMode: "HTML",
            replyToMessageId: replyTo,
            replyMarkup: markup,
        });
        if (rendered.ok) {
            if (rendered.messageId !== undefined) messageIds.push(rendered.messageId);
            continue;
        }

        // Telegram rejected the rendered markup. Retry this chunk as plain text so
        // the user still receives the content instead of silence.
        console.warn(
            `[Telegram] Falling back to plain text (${rendered.status})${rendered.description ? `: ${rendered.description}` : ""}`
        );
        const plain = await callTelegramSendMessage({
            botToken: params.botToken,
            chatId: params.chatId,
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
        if (plain.messageId !== undefined) messageIds.push(plain.messageId);
    }

    return messageIds;
}

/**
 * The line that says which chat a message came from.
 *
 * Added where the conversation moves under the person: a scheduled run's
 * report starts a chat of its own, a reply can continue an older one. In a
 * messenger there is no chat list to look at, so the message has to say it.
 */
export function withChatFooter(text: string, title: string | null | undefined): string {
    const name = title?.replace(/\s+/g, " ").trim();
    if (!name) return text;
    return `${text.trimEnd()}\n\n💬 ${name.length > 80 ? `${name.slice(0, 79)}…` : name}`;
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
export function projectKeyboard(
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
