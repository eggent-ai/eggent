import {
    getTelegramIntegrationRuntimeConfig,
    detectTelegramMode,
    type TelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import { telegramPollingService } from "@/lib/telegram/polling-service";

let lifecycleInitialized = false;

interface TelegramLifecycleOptions {
    autoStartPolling?: boolean;
    autoSetupWebhook?: boolean;
}

export async function initTelegramLifecycle(
    options: TelegramLifecycleOptions = {}
): Promise<void> {
    if (lifecycleInitialized) {
        return;
    }

    const runtime = await getTelegramIntegrationRuntimeConfig();
    const detectedMode = detectTelegramMode(runtime);

    console.log(`[Telegram Lifecycle] Mode: ${runtime.mode}, Detected: ${detectedMode}`);

    if (detectedMode === "polling") {
        if (options.autoStartPolling !== false && runtime.botToken.trim()) {
            try {
                await telegramPollingService.start(runtime);
                console.log("[Telegram Lifecycle] Polling started automatically");
            } catch (error) {
                console.error("[Telegram Lifecycle] Failed to start polling:", error);
            }
        }
    } else if (detectedMode === "webhook") {
        if (options.autoSetupWebhook !== false && runtime.botToken.trim() && runtime.publicBaseUrl.trim()) {
            try {
                await setupTelegramWebhook(runtime);
                console.log("[Telegram Lifecycle] Webhook configured");
            } catch (error) {
                console.error("[Telegram Lifecycle] Failed to setup webhook:", error);
            }
        }
    }

    setupGracefulShutdown();
    lifecycleInitialized = true;
}

async function setupTelegramWebhook(
    runtime: TelegramIntegrationRuntimeConfig
): Promise<void> {
    const { botToken, publicBaseUrl, webhookSecret } = runtime;

    if (!botToken.trim() || !publicBaseUrl.trim()) {
        throw new Error("Bot token and public base URL are required");
    }

    const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/api/integrations/telegram`;

    const response = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: webhookUrl,
                secret_token: webhookSecret.trim() || undefined,
                allowed_updates: ["message"],
            }),
        }
    );

    const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string }
        | null;

    if (!response.ok || !payload?.ok) {
        throw new Error(
            `Failed to set webhook: ${payload?.description || response.statusText}`
        );
    }
}

export async function migrateToWebhook(
    runtime: TelegramIntegrationRuntimeConfig
): Promise<void> {
    // Stop polling if running
    if (telegramPollingService.status.isRunning) {
        telegramPollingService.stop();
        console.log("[Telegram Migration] Polling stopped");
    }

    // Setup webhook
    await setupTelegramWebhook(runtime);
    console.log("[Telegram Migration] Migrated to webhook mode");
}

export async function migrateToPolling(
    runtime: TelegramIntegrationRuntimeConfig
): Promise<void> {
    // Delete webhook
    await deleteTelegramWebhook(runtime.botToken);

    // Start polling
    if (!telegramPollingService.status.isRunning) {
        await telegramPollingService.start(runtime);
        console.log("[Telegram Migration] Migrated to polling mode");
    }
}

async function deleteTelegramWebhook(botToken: string): Promise<void> {
    const response = await fetch(
        `https://api.telegram.org/bot${botToken}/deleteWebhook`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ drop_pending_updates: false }),
        }
    );

    const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; description?: string }
        | null;

    if (payload?.ok) {
        console.log("[Telegram Lifecycle] Webhook deleted");
    } else {
        console.warn("[Telegram Lifecycle] Failed to delete webhook:", payload?.description);
    }
}

function setupGracefulShutdown(): void {
    const shutdown = () => {
        console.log("[Telegram Lifecycle] Shutting down...");
        if (telegramPollingService.status.isRunning) {
            telegramPollingService.stop();
        }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

export function isLifecycleInitialized(): boolean {
    return lifecycleInitialized;
}
