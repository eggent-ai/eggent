import { NextRequest } from "next/server";
import {
  getTelegramIntegrationPublicSettings,
  saveTelegramIntegrationFromPublicInput,
} from "@/lib/storage/telegram-integration-store";

export async function GET() {
  try {
    const settings = await getTelegramIntegrationPublicSettings();
    return Response.json(settings);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Telegram integration settings",
      },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
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
            : "Failed to save Telegram integration settings",
      },
      { status: 500 }
    );
  }
}
