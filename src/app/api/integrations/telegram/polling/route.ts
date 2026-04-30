import { NextRequest } from "next/server";
import {
    getTelegramIntegrationRuntimeConfig,
    detectTelegramMode,
} from "@/lib/storage/telegram-integration-store";
import { telegramPollingService } from "@/lib/telegram/polling-service";

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
    try {
        const runtime = await getTelegramIntegrationRuntimeConfig();
        const detectedMode = detectTelegramMode(runtime);

        if (!runtime.botToken.trim()) {
            return Response.json(
                { error: "Telegram bot token is not configured" },
                { status: 503 }
            );
        }

        // Only allow polling if detected mode is polling or user explicitly forces it
        const body = (await req.json().catch(() => ({}))) as { force?: boolean };
        const force = body.force === true;

        if (detectedMode === "webhook" && !force) {
            return Response.json(
                {
                    error: "Detected mode is webhook. Use force=true to start polling anyway.",
                    detectedMode,
                },
                { status: 400 }
            );
        }

        if (telegramPollingService.status.isRunning) {
            return Response.json(
                {
                    error: "Polling is already running",
                    polling: telegramPollingService.status,
                },
                { status: 409 }
            );
        }

        await telegramPollingService.start(runtime);

        return Response.json({
            ok: true,
            message: "Polling started",
            polling: telegramPollingService.status,
        });
    } catch (error) {
        console.error("[Telegram Polling API] Error starting polling:", error);
        return Response.json(
            {
                error: error instanceof Error ? error.message : "Failed to start polling",
            },
            { status: 500 }
        );
    }
}

export async function DELETE() {
    try {
        if (!telegramPollingService.status.isRunning) {
            return Response.json(
                { error: "Polling is not running" },
                { status: 409 }
            );
        }

        telegramPollingService.stop();

        return Response.json({
            ok: true,
            message: "Polling stopped",
            polling: telegramPollingService.status,
        });
    } catch (error) {
        console.error("[Telegram Polling API] Error stopping polling:", error);
        return Response.json(
            {
                error: error instanceof Error ? error.message : "Failed to stop polling",
            },
            { status: 500 }
        );
    }
}
