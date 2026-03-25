import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  getTelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import {
  processTelegramUpdate,
  type TelegramUpdate,
} from "@/lib/telegram/telegram-message-handler";

function safeTokenMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(actualBytes, expectedBytes);
}

export const maxDuration = 300;

export async function GET() {
  return Response.json({
    status: "ok",
    integration: "telegram",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  const runtime = await getTelegramIntegrationRuntimeConfig();
  const botToken = runtime.botToken.trim();
  const webhookSecret = runtime.webhookSecret.trim();

  if (!botToken || !webhookSecret) {
    return Response.json(
      {
        error:
          "Telegram integration is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.",
      },
      { status: 503 }
    );
  }

  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (!providedSecret || !safeTokenMatch(providedSecret, webhookSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as TelegramUpdate;
    const result = await processTelegramUpdate(body, runtime);
    return Response.json(result);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
