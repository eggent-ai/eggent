export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();

  if (!botToken || !webhookSecret) return;

  const baseUrl = inferBaseUrl();
  if (!baseUrl) {
    console.warn(
      "[Telegram] Skipping auto-webhook: no APP_BASE_URL or deployment URL detected"
    );
    return;
  }

  const webhookUrl = `${baseUrl}/api/integrations/telegram`;

  try {
    const infoRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`
    );
    const info = (await infoRes.json()) as {
      ok?: boolean;
      result?: { url?: string };
    };

    if (info.ok && info.result?.url === webhookUrl) {
      console.log("[Telegram] Webhook already registered:", webhookUrl);
      return;
    }

    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: webhookSecret,
          drop_pending_updates: false,
        }),
      }
    );

    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
    };

    if (data.ok) {
      console.log("[Telegram] Webhook auto-registered:", webhookUrl);
    } else {
      console.warn(
        "[Telegram] Webhook auto-registration failed:",
        data.description
      );
    }
  } catch (error) {
    console.warn("[Telegram] Webhook auto-registration error:", error);
  }
}

function inferBaseUrl(): string {
  const explicit = (process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  // Vercel
  const vercelUrl = (process.env.VERCEL_URL ?? "").trim();
  if (vercelUrl) return `https://${vercelUrl}`;

  // Railway
  const railwayUrl = (
    process.env.RAILWAY_PUBLIC_DOMAIN ??
    process.env.RAILWAY_STATIC_URL ??
    ""
  ).trim();
  if (railwayUrl) {
    return railwayUrl.startsWith("http") ? railwayUrl : `https://${railwayUrl}`;
  }

  // Render
  const renderUrl = (process.env.RENDER_EXTERNAL_URL ?? "").trim();
  if (renderUrl) return renderUrl;

  // Fly.io
  const flyApp = (process.env.FLY_APP_NAME ?? "").trim();
  if (flyApp) return `https://${flyApp}.fly.dev`;

  return "";
}
