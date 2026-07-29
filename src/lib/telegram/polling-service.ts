import {
    detectTelegramMode,
    getTelegramIntegrationRuntimeConfig,
    type TelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import {
    processTelegramUpdate,
    type TelegramUpdate,
} from "@/lib/telegram/telegram-message-handler";
import { setEggentTelegramBotCommands } from "@/lib/telegram/bot-commands";

interface TelegramApiResponse {
    ok?: boolean;
    description?: string;
    result?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export type TelegramPollErrorKind = "transient" | "conflict" | "fatal";

export interface PollingStatus {
    isRunning: boolean;
    lastUpdateId: number | null;
    lastPollTime: string | null;
    errorCount: number;
    consecutiveErrors: number;
    /** Non-null while polling is degraded, so the UI and /api/health can surface it. */
    lastError: { kind: TelegramPollErrorKind; message: string; at: string } | null;
    /** Current backoff between polls, in ms. Equals the configured interval when healthy. */
    backoffMs: number;
}

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
const CONFLICT_BACKOFF_MS = 60_000;
const MAX_UPDATE_ATTEMPTS = 3;

/**
 * Telegram polling failures are not equal:
 * - `fatal`   — the token is rejected; retrying can never succeed.
 * - `conflict` — another process is polling the same token. Retrying is correct,
 *                but only the user can actually resolve it.
 * - `transient` — network blips, 429s, 5xx. Always retry.
 */
export function classifyTelegramPollError(message: string): TelegramPollErrorKind {
    const normalized = message.toLowerCase();
    if (normalized.includes("unauthorized") || normalized.includes("(401)") || normalized.includes("(403)")) {
        return "fatal";
    }
    if (normalized.includes("conflict") || normalized.includes("(409)")) {
        return "conflict";
    }
    return "transient";
}

class TelegramPollingService {
    private isRunning = false;
    private abortController: AbortController | null = null;
    private lastUpdateId: number | null = null;
    private errorCount = 0;
    private consecutiveErrors = 0;
    private lastPollTime: string | null = null;
    private runtimeConfig: TelegramIntegrationRuntimeConfig | null = null;
    private pollTimeout: NodeJS.Timeout | null = null;
    private lastError: PollingStatus["lastError"] = null;
    private backoffMs = 0;
    private failingUpdateId: number | null = null;
    private failingUpdateAttempts = 0;

    private extractUpdateId(update: TelegramUpdate): number | null {
        return typeof update.update_id === "number" && Number.isInteger(update.update_id)
            ? update.update_id
            : null;
    }

    get status(): PollingStatus {
        return {
            isRunning: this.isRunning,
            lastUpdateId: this.lastUpdateId,
            lastPollTime: this.lastPollTime,
            errorCount: this.errorCount,
            consecutiveErrors: this.consecutiveErrors,
            lastError: this.lastError,
            backoffMs: this.backoffMs || (this.runtimeConfig?.pollingInterval ?? 5000),
        };
    }

    private recordError(kind: TelegramPollErrorKind, message: string): void {
        this.lastError = { kind, message, at: new Date().toISOString() };
    }

    private nextBackoff(kind: TelegramPollErrorKind): number {
        if (kind === "conflict") return CONFLICT_BACKOFF_MS;
        const exponent = Math.max(0, this.consecutiveErrors - 1);
        return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
    }

    async start(runtimeConfig: TelegramIntegrationRuntimeConfig): Promise<void> {
        if (this.isRunning) {
            throw new Error("Polling is already running");
        }

        if (!runtimeConfig.botToken.trim()) {
            throw new Error("Bot token is required");
        }

        this.runtimeConfig = runtimeConfig;
        this.isRunning = true;
        this.abortController = new AbortController();
        this.errorCount = 0;
        this.consecutiveErrors = 0;

        console.log("[Telegram Polling] Starting polling service...");

        // Delete webhook if exists to ensure polling works
        await this.deleteWebhook(runtimeConfig.botToken);
        await setEggentTelegramBotCommands(runtimeConfig.botToken);

        // Start first poll immediately
        this.scheduleNextPoll(0);
    }

    stop(): void {
        if (!this.isRunning) {
            return;
        }

        console.log("[Telegram Polling] Stopping polling service...");

        this.isRunning = false;

        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.runtimeConfig = null;
    }

    private scheduleNextPoll(delay?: number): void {
        if (!this.isRunning) {
            return;
        }

        const actualDelay = delay ?? this.runtimeConfig?.pollingInterval ?? 5000;

        this.pollTimeout = setTimeout(() => {
            this.poll();
        }, actualDelay);
    }

    private async poll(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        try {
            const runtimeConfig = await getTelegramIntegrationRuntimeConfig();
            const botToken = runtimeConfig.botToken.trim();
            if (!botToken) {
                console.log("[Telegram Polling] Bot token removed, stopping polling service");
                this.stop();
                return;
            }

            const detectedMode = detectTelegramMode(runtimeConfig);
            if (detectedMode !== "polling") {
                console.log("[Telegram Polling] Detected mode is webhook, stopping polling service");
                this.stop();
                return;
            }

            this.runtimeConfig = runtimeConfig;
            const updates = await this.getUpdates(botToken);

            this.consecutiveErrors = 0;
            this.lastError = null;
            this.backoffMs = 0;
            this.lastPollTime = new Date().toISOString();

            let retrySoon = false;

            for (const update of updates) {
                if (!this.isRunning) break;
                const updateId = this.extractUpdateId(update);
                if (updateId === null) {
                    console.warn("[Telegram Polling] Received update without valid update_id, skipping");
                    continue;
                }

                const processed = await this.processUpdate(update, runtimeConfig);
                if (!processed) {
                    // Retry a failed update a few times, then skip it. Without this a
                    // single unprocessable message wedges the offset and the bot stops
                    // receiving anything at all.
                    if (this.failingUpdateId === updateId) {
                        this.failingUpdateAttempts += 1;
                    } else {
                        this.failingUpdateId = updateId;
                        this.failingUpdateAttempts = 1;
                    }

                    if (this.failingUpdateAttempts >= MAX_UPDATE_ATTEMPTS) {
                        console.error(
                            `[Telegram Polling] Skipping update ${updateId} after ${this.failingUpdateAttempts} failed attempts`
                        );
                        this.lastUpdateId = updateId;
                        this.failingUpdateId = null;
                        this.failingUpdateAttempts = 0;
                        continue;
                    }

                    retrySoon = true;
                    break;
                }

                // Confirm only successfully processed updates to avoid data loss.
                this.lastUpdateId = updateId;
                if (this.failingUpdateId === updateId) {
                    this.failingUpdateId = null;
                    this.failingUpdateAttempts = 0;
                }
            }

            if (retrySoon) {
                this.scheduleNextPoll(1000);
                return;
            }
        } catch (error) {
            if (
                !this.isRunning &&
                error instanceof Error &&
                error.name === "AbortError"
            ) {
                return;
            }

            this.errorCount++;
            this.consecutiveErrors++;

            const errorMessage = error instanceof Error ? error.message : String(error);
            const kind = classifyTelegramPollError(errorMessage);
            this.recordError(kind, errorMessage);

            if (kind === "fatal") {
                // The token itself is rejected. Retrying cannot help and would only
                // hammer the API, so stop and leave the reason visible in status.
                console.error("[Telegram Polling] Bot token rejected, stopping polling:", errorMessage);
                this.isRunning = false;
                if (this.pollTimeout) {
                    clearTimeout(this.pollTimeout);
                    this.pollTimeout = null;
                }
                this.abortController?.abort();
                this.abortController = null;
                return;
            }

            this.backoffMs = this.nextBackoff(kind);
            console.error(
                `[Telegram Polling] ${kind} error (consecutive: ${this.consecutiveErrors}), retrying in ${this.backoffMs}ms:`,
                errorMessage
            );

            if (kind === "conflict") {
                console.error(
                    "[Telegram Polling] Another process is polling this bot token. " +
                    "Polling keeps retrying, but the duplicate consumer must be stopped by the workspace owner."
                );
            }

            this.scheduleNextPoll(this.backoffMs);
            return;
        }

        this.scheduleNextPoll();
    }

    private async getUpdates(botToken: string): Promise<TelegramUpdate[]> {
        const params: Record<string, unknown> = {
            limit: 100,
            timeout: 30,
        };

        if (this.lastUpdateId !== null) {
            params.offset = this.lastUpdateId + 1;
        }

        const response = await fetch(
            `https://api.telegram.org/bot${botToken}/getUpdates`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
                signal: this.abortController?.signal,
            }
        );

        const payload = (await response.json().catch(() => null)) as
            | TelegramApiResponse
            | null;

        if (!response.ok || !payload?.ok) {
            const description = payload?.description || "Unknown error";
            throw new Error(`getUpdates failed (${response.status}): ${description}`);
        }

        const result = payload.result;
        if (!Array.isArray(result)) {
            return [];
        }

        return result as TelegramUpdate[];
    }

    private async processUpdate(
        update: TelegramUpdate,
        runtimeConfig: TelegramIntegrationRuntimeConfig
    ): Promise<boolean> {
        try {
            await processTelegramUpdate(update, runtimeConfig);
            return true;
        } catch (error) {
            this.errorCount++;
            const message = error instanceof Error ? error.message : String(error);
            this.recordError("transient", message);
            console.error("[Telegram Polling] Error processing update:", message);
            // Never stop polling because of a bad update — poll() retries this
            // update a few times and then skips it.
            return false;
        }
    }

    private async deleteWebhook(botToken: string): Promise<void> {
        try {
            const response = await fetch(
                `https://api.telegram.org/bot${botToken}/deleteWebhook`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ drop_pending_updates: false }),
                }
            );

            const payload = (await response.json().catch(() => null)) as
                | TelegramApiResponse
                | null;

            if (payload?.ok) {
                console.log("[Telegram Polling] Webhook deleted successfully");
            } else {
                console.warn("[Telegram Polling] Failed to delete webhook:", payload?.description);
            }
        } catch (error) {
            console.warn("[Telegram Polling] Error deleting webhook:", error);
        }
    }
}

export const telegramPollingService = new TelegramPollingService();
