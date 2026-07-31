/**
 * Connecting and disconnecting the workspace Telegram bot.
 *
 * Shared by the settings API and by the `eggent_manage_telegram` agent tool, so
 * that a bot connected by asking the agent is configured exactly like one
 * connected through the UI. Anything less produced bots that could send a
 * message but never received one.
 */

import {
  buildTelegramWebhookUrl,
  generateTelegramWebhookSecret,
  getTelegramIntegrationRuntimeConfig,
  getTelegramIntegrationStoredSettings,
  saveTelegramIntegrationStoredSettings,
} from "@/lib/storage/telegram-integration-store";
import { deleteEggentTelegramBotCommands, setEggentTelegramBotCommands } from "@/lib/telegram/bot-commands";
import { telegramPollingService } from "@/lib/telegram/polling-service";
import type { MessageKey } from "@/i18n/messages";

export type TelegramSetupMode = "polling" | "webhook";
type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

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

export interface TelegramConnectResult {
  mode: TelegramSetupMode;
  botUsername: string | null;
  botLink: string | null;
  webhookUrl?: string;
  claimWarning: string | null;
}

export interface TelegramDisconnectResult {
  webhookRemoved: boolean;
  webhookWarning: string | null;
}

function parseTelegramError(status: number, payload: TelegramApiResponse | null): string {
  const description = payload?.description?.trim();
  return description ? `Telegram API error (${status}): ${description}` : `Telegram API error (${status})`;
}

export async function callTelegramBotApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
  return payload;
}

export async function getTelegramBotInfo(botToken: string): Promise<TelegramGetMeResult> {
  const payload = await callTelegramBotApi(botToken, "getMe");
  return payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? (payload.result as TelegramGetMeResult)
    : {};
}

async function deleteTelegramWebhook(botToken: string): Promise<void> {
  await callTelegramBotApi(botToken, "deleteWebhook", { drop_pending_updates: false });
}

/**
 * Tell the hosting control plane that this bot token now belongs to this
 * workspace, so a shared onboarding bot stops polling it. No-op when the
 * deployment does not provide a claim endpoint.
 */
async function claimHostedTelegramBot(botToken: string, t: Translate): Promise<string | null> {
  const claimUrl = process.env.EGGENT_CLOUD_TELEGRAM_CLAIM_URL?.trim();
  const instanceId = process.env.EGGENT_CLOUD_INSTANCE_ID?.trim();
  const instanceToken = process.env.EXTERNAL_API_TOKEN?.trim();
  if (!claimUrl || !instanceId || !instanceToken) return null;

  try {
    const response = await fetch(claimUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${instanceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId, botToken }),
    });
    if (response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    return payload?.error || `${t("api.error.telegramCloudClaimFailed")} (${response.status})`;
  } catch (error) {
    return error instanceof Error ? error.message : t("api.error.telegramCloudClaimFailed");
  }
}

async function setTelegramBotWelcome(botToken: string, t: Translate): Promise<void> {
  await Promise.allSettled([
    callTelegramBotApi(botToken, "setMyDescription", { description: t("api.telegram.botDescription") }),
    callTelegramBotApi(botToken, "setMyShortDescription", {
      short_description: t("api.telegram.botShortDescription"),
    }),
  ]);
}

async function setTelegramWebhook(params: {
  botToken: string;
  webhookUrl: string;
  webhookSecret: string;
}): Promise<void> {
  await callTelegramBotApi(params.botToken, "setWebhook", {
    url: params.webhookUrl,
    secret_token: params.webhookSecret,
    drop_pending_updates: false,
  });
}

/**
 * Validate the token, persist the integration, and start receiving updates.
 *
 * `botToken` may be omitted to re-apply the already stored token. Throws with a
 * Telegram-provided message when the token is rejected.
 */
export async function connectTelegramBot(params: {
  botToken?: string;
  mode?: TelegramSetupMode;
  fallbackPublicBaseUrl?: string;
  t: Translate;
}): Promise<TelegramConnectResult> {
  const { t } = params;
  const inputToken = params.botToken?.trim() || "";

  const stored = await getTelegramIntegrationStoredSettings();
  const runtime = await getTelegramIntegrationRuntimeConfig();
  const storedToken = stored.botToken.trim();

  const botToken = inputToken || storedToken || runtime.botToken.trim();
  if (!botToken) throw new Error(t("api.error.telegramTokenRequired"));

  const mode: TelegramSetupMode = params.mode === "webhook" ? "webhook" : "polling";
  const botInfo = await getTelegramBotInfo(botToken);

  const claimWarning = mode === "polling" ? await claimHostedTelegramBot(botToken, t) : null;
  if (claimWarning) console.warn("Telegram cloud claim warning:", claimWarning);

  const webhookSecret =
    stored.webhookSecret.trim() || runtime.webhookSecret.trim() || generateTelegramWebhookSecret();
  const publicBaseUrl =
    stored.publicBaseUrl.trim() || runtime.publicBaseUrl.trim() || params.fallbackPublicBaseUrl?.trim() || "";

  await saveTelegramIntegrationStoredSettings({
    botToken: inputToken ? botToken : storedToken || undefined,
    webhookSecret,
    publicBaseUrl: publicBaseUrl || undefined,
    defaultProjectId: stored.defaultProjectId,
    mode,
  });

  const botUsername = botInfo.username || null;
  const botLink = botUsername ? `https://t.me/${botUsername}` : null;

  if (mode === "webhook") {
    if (!publicBaseUrl) throw new Error(t("api.error.telegramPublicUrlRequired"));
    const webhookUrl = buildTelegramWebhookUrl(publicBaseUrl);
    await setTelegramWebhook({ botToken, webhookUrl, webhookSecret });
    await setEggentTelegramBotCommands(botToken);
    await setTelegramBotWelcome(botToken, t);
    return { mode, botUsername, botLink, webhookUrl, claimWarning };
  }

  await deleteTelegramWebhook(botToken);
  await setEggentTelegramBotCommands(botToken);
  await setTelegramBotWelcome(botToken, t);
  const nextRuntime = await getTelegramIntegrationRuntimeConfig();
  if (!telegramPollingService.status.isRunning) {
    await telegramPollingService.start(nextRuntime);
  }

  return { mode, botUsername, botLink, claimWarning };
}

export async function disconnectTelegramBot(t: Translate): Promise<TelegramDisconnectResult> {
  const runtime = await getTelegramIntegrationRuntimeConfig();
  const stored = await getTelegramIntegrationStoredSettings();
  const botToken = runtime.botToken.trim();

  let webhookRemoved = false;
  let webhookWarning: string | null = null;

  if (botToken) {
    try {
      await deleteTelegramWebhook(botToken);
      await deleteEggentTelegramBotCommands(botToken);
      webhookRemoved = true;
    } catch (error) {
      webhookWarning = error instanceof Error ? error.message : t("api.error.telegramWebhookRemoveFailed");
    }
  }

  if (telegramPollingService.status.isRunning) {
    telegramPollingService.stop();
  }

  await saveTelegramIntegrationStoredSettings({
    botToken: "",
    webhookSecret: "",
    publicBaseUrl: stored.publicBaseUrl,
    defaultProjectId: stored.defaultProjectId,
  });

  return { webhookRemoved, webhookWarning };
}
