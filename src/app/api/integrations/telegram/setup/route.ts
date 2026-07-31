import { NextRequest } from "next/server";
import { getTelegramIntegrationPublicSettings } from "@/lib/storage/telegram-integration-store";
import { connectTelegramBot } from "@/lib/telegram/setup";
import { getServerTranslator } from "@/i18n/server";

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
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = (await req.json().catch(() => ({}))) as {
      botToken?: unknown;
      mode?: unknown;
    };

    const result = await connectTelegramBot({
      botToken: typeof body.botToken === "string" ? body.botToken : undefined,
      mode: body.mode === "webhook" ? "webhook" : "polling",
      fallbackPublicBaseUrl: inferPublicBaseUrl(req),
      t,
    });

    const settings = await getTelegramIntegrationPublicSettings();

    if (result.mode === "webhook") {
      return Response.json({
        success: true,
        message: t("api.success.telegramWebhookConnected"),
        mode: result.mode,
        webhookUrl: result.webhookUrl,
        botUsername: result.botUsername,
        botLink: result.botLink,
        claimWarning: result.claimWarning,
        settings,
      });
    }

    return Response.json({
      success: true,
      message: result.botUsername
        ? t("api.success.telegramPollingOpenBot", { username: result.botUsername })
        : t("api.success.telegramPollingOpenGeneric"),
      mode: result.mode,
      botUsername: result.botUsername,
      botLink: result.botLink,
      claimWarning: result.claimWarning,
      settings,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : t("api.error.telegramSetupFailed"),
      },
      { status: 500 }
    );
  }
}
