import {
  getTelegramIntegrationPublicSettings,
  getTelegramIntegrationRuntimeConfig,
  getTelegramIntegrationStoredSettings,
  saveTelegramIntegrationStoredSettings,
} from "@/lib/storage/telegram-integration-store";

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

export async function POST() {
  try {
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const stored = await getTelegramIntegrationStoredSettings();
    const botToken = runtime.botToken.trim();

    let webhookRemoved = false;
    let webhookWarning: string | null = null;

    if (botToken) {
      try {
        await deleteTelegramWebhook(botToken);
        webhookRemoved = true;
      } catch (error) {
        webhookWarning =
          error instanceof Error
            ? error.message
            : "Failed to remove Telegram webhook";
      }
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
        ? "Token is still provided by .env. Remove TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to fully disconnect."
        : null;

    return Response.json({
      success: true,
      message: "Telegram disconnected",
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
            : "Failed to disconnect Telegram integration",
      },
      { status: 500 }
    );
  }
}
