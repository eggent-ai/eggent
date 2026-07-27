import { NextRequest } from "next/server";
import {
    getTelegramIntegrationRuntimeConfig,
    detectTelegramMode,
} from "@/lib/storage/telegram-integration-store";
import { telegramPollingService } from "@/lib/telegram/polling-service";
import { getServerTranslator } from "@/i18n/server";

export const maxDuration = 300;

export async function GET() {
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const detectedMode = detectTelegramMode(runtime);

    return Response.json({
        status: "ok",
        polling: telegramPollingService.status,
        config: {
            mode: runtime.mode,
            detectedMode,
            canStartPolling: !!runtime.botToken && detectedMode === "polling",
        },
    });
}

export async function POST(req: NextRequest) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    try {
        const runtime = await getTelegramIntegrationRuntimeConfig();
        const detectedMode = detectTelegramMode(runtime);

        if (!runtime.botToken.trim()) {
            return Response.json(
                { error: t("api.error.telegramTokenMissing") },
                { status: 503 }
            );
        }

        // Only allow polling if detected mode is polling or user explicitly forces it
        const body = (await req.json().catch(() => ({}))) as { force?: boolean };
        const force = body.force === true;

        if (detectedMode === "webhook" && !force) {
            return Response.json(
                {
                    error: t("api.error.pollingWebhookMode"),
                    detectedMode,
                },
                { status: 400 }
            );
        }

        if (telegramPollingService.status.isRunning) {
            return Response.json(
                {
                    error: t("api.error.pollingAlreadyRunning"),
                    polling: telegramPollingService.status,
                },
                { status: 409 }
            );
        }

        await telegramPollingService.start(runtime);

        return Response.json({
            ok: true,
            message: t("api.success.pollingStarted"),
            polling: telegramPollingService.status,
        });
    } catch (error) {
        console.error("[Telegram Polling API] Error starting polling:", error);
        return Response.json(
            {
                error: error instanceof Error ? error.message : t("api.error.pollingStartFailed"),
            },
            { status: 500 }
        );
    }
}

export async function DELETE(req: NextRequest) {
    const t = await getServerTranslator(req.headers.get("accept-language"));
    try {
        if (!telegramPollingService.status.isRunning) {
            return Response.json(
                { error: t("api.error.pollingNotRunning") },
                { status: 409 }
            );
        }

        telegramPollingService.stop();

        return Response.json({
            ok: true,
            message: t("api.success.pollingStopped"),
            polling: telegramPollingService.status,
        });
    } catch (error) {
        console.error("[Telegram Polling API] Error stopping polling:", error);
        return Response.json(
            {
                error: error instanceof Error ? error.message : t("api.error.pollingStopFailed"),
            },
            { status: 500 }
        );
    }
}
