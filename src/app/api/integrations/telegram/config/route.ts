import { NextRequest } from "next/server";
import {
  getTelegramIntegrationPublicSettings,
  saveTelegramIntegrationFromPublicInput,
} from "@/lib/storage/telegram-integration-store";
import { getServerTranslator } from "@/i18n/server";

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const settings = await getTelegramIntegrationPublicSettings();
    return Response.json(settings);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramConfigLoadFailed"),
      },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = (await req.json()) as Record<string, unknown>;
    await saveTelegramIntegrationFromPublicInput(body);
    const settings = await getTelegramIntegrationPublicSettings();
    return Response.json({
      success: true,
      ...settings,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramConfigSaveFailed"),
      },
      { status: 500 }
    );
  }
}
