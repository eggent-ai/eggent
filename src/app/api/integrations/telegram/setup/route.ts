import { NextRequest } from "next/server";
import {
  buildTelegramWebhookUrl,
  generateTelegramWebhookSecret,
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

async function setTelegramWebhook(params: {
  botToken: string;
  webhookUrl: string;
  webhookSecret: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${params.botToken}/setWebhook`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: params.webhookUrl,
        secret_token: params.webhookSecret,
        drop_pending_updates: false,
      }),
    }
  );

  const payload = (await response.json().catch(() => null)) as
    | TelegramApiResponse
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
}

function inferPublicBaseUrl(req: NextRequest): string {
  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || req.headers.get("host")?.trim();
  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();

  if (host) {
    const proto =
      forwardedProto ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return `${proto}://${host}`;
  }

  const origin = req.nextUrl.origin?.trim();
  if (origin && origin !== "null") {
    return origin;
  }

  return "";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      botToken?: unknown;
    };
    const inputToken =
      typeof body.botToken === "string" ? body.botToken.trim() : "";

    const stored = await getTelegramIntegrationStoredSettings();
    const runtime = await getTelegramIntegrationRuntimeConfig();
    const storedToken = stored.botToken.trim();

    const botToken = inputToken || storedToken || runtime.botToken.trim();
    if (!botToken) {
      return Response.json(
        { error: "Telegram bot token is required" },
        { status: 400 }
      );
    }

    const webhookSecret =
      stored.webhookSecret.trim() ||
      runtime.webhookSecret.trim() ||
      generateTelegramWebhookSecret();
    const publicBaseUrl =
      stored.publicBaseUrl.trim() ||
      runtime.publicBaseUrl.trim() ||
      inferPublicBaseUrl(req);

    if (!publicBaseUrl) {
      return Response.json(
        {
          error:
            "Public base URL is required. Set APP_BASE_URL or access the app via public host.",
        },
        { status: 400 }
      );
    }

    const webhookUrl = buildTelegramWebhookUrl(publicBaseUrl);

    await saveTelegramIntegrationStoredSettings({
      botToken: inputToken ? botToken : storedToken || undefined,
      webhookSecret,
      publicBaseUrl,
      defaultProjectId: stored.defaultProjectId,
    });

    await setTelegramWebhook({
      botToken,
      webhookUrl,
      webhookSecret,
    });

    const settings = await getTelegramIntegrationPublicSettings();

    return Response.json({
      success: true,
      message: "Telegram connected",
      webhookUrl,
      settings,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to configure Telegram integration",
      },
      { status: 500 }
    );
  }
}
