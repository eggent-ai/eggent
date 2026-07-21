import { NextRequest } from "next/server";
import {
  buildTelegramWebhookUrl,
  generateTelegramWebhookSecret,
  getTelegramIntegrationPublicSettings,
  getTelegramIntegrationRuntimeConfig,
  getTelegramIntegrationStoredSettings,
  saveTelegramIntegrationStoredSettings,
} from "@/lib/storage/telegram-integration-store";
import { setEggentTelegramBotCommands } from "@/lib/telegram/bot-commands";
import { telegramPollingService } from "@/lib/telegram/polling-service";

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
}

interface TelegramGetMeResult {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

function parseTelegramError(status: number, payload: TelegramApiResponse | null): string {
  const description = payload?.description?.trim();
  return description
    ? `Telegram API error (${status}): ${description}`
    : `Telegram API error (${status})`;
}

async function callTelegramBotApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const payload = (await response.json().catch(() => null)) as
    | TelegramApiResponse
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
  return payload;
}

async function getTelegramBotInfo(botToken: string): Promise<TelegramGetMeResult> {
  const payload = await callTelegramBotApi(botToken, "getMe");
  return payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? (payload.result as TelegramGetMeResult)
    : {};
}

async function deleteTelegramWebhook(botToken: string): Promise<void> {
  await callTelegramBotApi(botToken, "deleteWebhook", {
    drop_pending_updates: false,
  });
}

async function setTelegramBotWelcome(botToken: string): Promise<void> {
  const description = "Eggent is connected. Send /start to begin.";
  await Promise.allSettled([
    callTelegramBotApi(botToken, "setMyDescription", { description }),
    callTelegramBotApi(botToken, "setMyShortDescription", {
      short_description: "Chat with your Eggent workspace.",
    }),
  ]);
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
      mode?: unknown;
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

    const requestedMode = body.mode === "webhook" ? "webhook" : "polling";
    const botInfo = await getTelegramBotInfo(botToken);
    const webhookSecret =
      stored.webhookSecret.trim() ||
      runtime.webhookSecret.trim() ||
      generateTelegramWebhookSecret();
    const publicBaseUrl =
      stored.publicBaseUrl.trim() ||
      runtime.publicBaseUrl.trim() ||
      inferPublicBaseUrl(req);

    await saveTelegramIntegrationStoredSettings({
      botToken: inputToken ? botToken : storedToken || undefined,
      webhookSecret,
      publicBaseUrl: publicBaseUrl || undefined,
      defaultProjectId: stored.defaultProjectId,
      mode: requestedMode,
    });

    if (requestedMode === "webhook") {
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
      await setTelegramWebhook({ botToken, webhookUrl, webhookSecret });
      await setEggentTelegramBotCommands(botToken);
      await setTelegramBotWelcome(botToken);
      const settings = await getTelegramIntegrationPublicSettings();
      return Response.json({
        success: true,
        message: "Telegram webhook connected",
        mode: "webhook",
        webhookUrl,
        botUsername: botInfo.username || null,
        botLink: botInfo.username ? `https://t.me/${botInfo.username}` : null,
        settings,
      });
    }

    await deleteTelegramWebhook(botToken);
    await setEggentTelegramBotCommands(botToken);
    await setTelegramBotWelcome(botToken);
    const nextRuntime = await getTelegramIntegrationRuntimeConfig();
    if (!telegramPollingService.status.isRunning) {
      await telegramPollingService.start(nextRuntime);
    }

    const settings = await getTelegramIntegrationPublicSettings();

    return Response.json({
      success: true,
      message: botInfo.username
        ? `Long polling started. Open @${botInfo.username} and send /start.`
        : "Long polling started. Open your bot in Telegram and send /start.",
      mode: "polling",
      botUsername: botInfo.username || null,
      botLink: botInfo.username ? `https://t.me/${botInfo.username}` : null,
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
