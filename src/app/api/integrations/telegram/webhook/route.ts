import { NextRequest } from "next/server";
import {
  buildTelegramWebhookUrl,
  getTelegramIntegrationRuntimeConfig,
} from "@/lib/storage/telegram-integration-store";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";

export const dynamic = "force-dynamic";

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: Record<string, unknown>;
}

function parseTelegramError(status: number, payload: TelegramApiResponse | null): string {
  const description = payload?.description?.trim();
  return description
    ? `Telegram API error (${status}): ${description}`
    : `Telegram API error (${status})`;
}

async function callTelegramApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as
    | TelegramApiResponse
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }

  return payload;
}

function ensureWebhookConfigured(config: {
  botToken: string;
  webhookSecret: string;
  publicBaseUrl: string;
}, t: (key: MessageKey) => string): { botToken: string; webhookSecret: string; webhookUrl: string } {
  const botToken = config.botToken.trim();
  const webhookSecret = config.webhookSecret.trim();
  if (!botToken) {
    throw new Error(t("api.error.telegramTokenMissing"));
  }
  if (!webhookSecret) {
    throw new Error(t("api.error.telegramSecretMissing"));
  }
  const webhookUrl = buildTelegramWebhookUrl(config.publicBaseUrl);
  return { botToken, webhookSecret, webhookUrl };
}

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const config = await getTelegramIntegrationRuntimeConfig();
    if (!config.botToken.trim()) {
      return Response.json({
        configured: false,
        webhook: null,
        message: t("api.error.telegramTokenMissing"),
      });
    }

    const payload = await callTelegramApi(config.botToken, "getWebhookInfo");
    const result = payload.result ?? {};
    return Response.json({
      configured: true,
      webhook: {
        url: typeof result.url === "string" ? result.url : "",
        hasCustomCertificate: Boolean(result.has_custom_certificate),
        pendingUpdateCount:
          typeof result.pending_update_count === "number"
            ? result.pending_update_count
            : 0,
        ipAddress:
          typeof result.ip_address === "string" ? result.ip_address : null,
        lastErrorDate:
          typeof result.last_error_date === "number" ? result.last_error_date : null,
        lastErrorMessage:
          typeof result.last_error_message === "string"
            ? result.last_error_message
            : null,
        maxConnections:
          typeof result.max_connections === "number" ? result.max_connections : null,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramWebhookStatusFailed"),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const { botToken, webhookSecret, webhookUrl } = ensureWebhookConfigured(runtime, t);

    await callTelegramApi(botToken, "setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      drop_pending_updates: false,
    });

    return Response.json({
      success: true,
      webhookUrl,
      message: t("api.success.telegramWebhookConfigured"),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramWebhookConfigureFailed"),
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const botToken = runtime.botToken.trim();
    if (!botToken) {
      return Response.json(
        { error: t("api.error.telegramTokenMissing") },
        { status: 400 }
      );
    }

    await callTelegramApi(botToken, "deleteWebhook", {
      drop_pending_updates: false,
    });

    return Response.json({
      success: true,
      message: t("api.success.telegramWebhookRemoved"),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramWebhookRemoveFailed"),
      },
      { status: 500 }
    );
  }
}
