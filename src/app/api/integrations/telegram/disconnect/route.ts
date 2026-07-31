import { NextRequest } from "next/server";
import { getTelegramIntegrationPublicSettings } from "@/lib/storage/telegram-integration-store";
import { disconnectTelegramBot } from "@/lib/telegram/setup";
import { getServerTranslator } from "@/i18n/server";

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const { webhookRemoved, webhookWarning } = await disconnectTelegramBot(t);

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
