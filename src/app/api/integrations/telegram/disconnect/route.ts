import { NextRequest } from "next/server";
import {
  getTelegramIntegrationPublicSettings,
  getTelegramIntegrationRuntimeConfig,
  getTelegramIntegrationStoredSettings,
  saveTelegramIntegrationStoredSettings,
} from "@/lib/storage/telegram-integration-store";
import { deleteEggentTelegramBotCommands } from "@/lib/telegram/bot-commands";
import { telegramPollingService } from "@/lib/telegram/polling-service";
import { getServerTranslator } from "@/i18n/server";

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

function parseTelegramError(status: number, payload: TelegramApiResponse | null): string {
  const description = payload?.description?.trim();
  return description
    ? `Telegram API error (${status}): ${description}`
    : `Telegram API error (${status})`;
}

async function deleteTelegramWebhook(botToken: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      drop_pending_updates: false,
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | TelegramApiResponse
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const stored = await getTelegramIntegrationStoredSettings();
    const botToken = runtime.botToken.trim();

    let webhookRemoved = false;
    let webhookWarning: string | null = null;

    if (botToken) {
      try {
        await deleteTelegramWebhook(botToken);
        await deleteEggentTelegramBotCommands(botToken);
        webhookRemoved = true;
      } catch (error) {
        webhookWarning =
          error instanceof Error
            ? error.message
            : t("api.error.telegramWebhookRemoveFailed");
      }
    }

    if (telegramPollingService.status.isRunning) {
      telegramPollingService.stop();
    }

    await saveTelegramIntegrationStoredSettings({
      botToken: "",
      webhookSecret: "",
      publicBaseUrl: stored.publicBaseUrl,
      defaultProjectId: stored.defaultProjectId,
    });

    const settings = await getTelegramIntegrationPublicSettings();
    const note =
      settings.sources.botToken === "env"
        ? t("api.error.telegramEnvTokenNote")
        : null;

    return Response.json({
      success: true,
      message: t("api.success.telegramDisconnected"),
      webhookRemoved,
      webhookWarning,
      note,
      settings,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramDisconnectFailed"),
      },
      { status: 500 }
    );
  }
}
