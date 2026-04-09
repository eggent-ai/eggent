import {
    detectTelegramMode,
    getTelegramIntegrationRuntimeConfig,
    type TelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import {
    processTelegramUpdate,
    type TelegramUpdate,
} from "@/lib/telegram/telegram-message-handler";

interface TelegramApiResponse {
    ok?: boolean;
    description?: string;
    result?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface PollingStatus {
    isRunning: boolean;
    lastUpdateId: number | null;
    lastPollTime: string | null;
    errorCount: number;
    consecutiveErrors: number;
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
        };
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
                throw new Error("Bot token is required");
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
                    retrySoon = true;
                    break;
                }

                // Confirm only successfully processed updates to avoid data loss.
                this.lastUpdateId = updateId;
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
            console.error(`[Telegram Polling] Error (consecutive: ${this.consecutiveErrors}):`, errorMessage);

            if (this.consecutiveErrors >= 10) {
                console.error("[Telegram Polling] Too many consecutive errors, stopping polling");
                this.stop();
                return;
            }
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
            this.consecutiveErrors++;
            console.error("[Telegram Polling] Error processing update:", error);

            if (this.consecutiveErrors >= 10) {
                console.error("[Telegram Polling] Too many consecutive processing errors, stopping polling");
                this.stop();
            }

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
                    body: JSON.stringify({ drop_pending_updates: true }),
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
