import { getServerTranslator } from "@/i18n/server";

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

async function getEggentTelegramBotCommands() {
  const t = await getServerTranslator();
  return [
    { command: "start", description: t("telegram.command.start") },
    { command: "help", description: t("telegram.command.help") },
    { command: "code", description: t("telegram.command.code") },
    { command: "new", description: t("telegram.command.new") },
  ];
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
): Promise<void> {
  const token = botToken.trim();
  if (!token) return;

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  const payload = (await response.json().catch(() => null)) as TelegramApiResponse | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(parseTelegramError(response.status, payload));
  }
}

export async function setEggentTelegramBotCommands(botToken: string): Promise<void> {
  await callTelegramBotApi(botToken, "setMyCommands", {
    commands: await getEggentTelegramBotCommands(),
    scope: { type: "default" },
  });
}

export async function deleteEggentTelegramBotCommands(botToken: string): Promise<void> {
  await callTelegramBotApi(botToken, "deleteMyCommands", {
    scope: { type: "default" },
  });
}
