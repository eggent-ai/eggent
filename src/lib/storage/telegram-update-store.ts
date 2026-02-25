import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const INTEGRATIONS_DIR = path.join(DATA_DIR, "integrations");
const TELEGRAM_DIR = path.join(INTEGRATIONS_DIR, "telegram");
const PROCESSED_UPDATES_FILE = path.join(TELEGRAM_DIR, "processed-updates.json");
const MAX_UPDATES_PER_BOT = 2000;

interface TelegramProcessedUpdatesState {
  updatesByBot: Record<string, number[]>;
  updatedAt: string;
}

function normalizeBotId(botId: string): string {
  const value = botId.trim();
  if (!value) return "default";
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "default";
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(TELEGRAM_DIR, { recursive: true });
}

async function loadState(): Promise<TelegramProcessedUpdatesState> {
  await ensureDir();
  try {
    const raw = await fs.readFile(PROCESSED_UPDATES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelegramProcessedUpdatesState>;
    const updatesByBot =
      parsed.updatesByBot && typeof parsed.updatesByBot === "object"
        ? parsed.updatesByBot
        : {};
    return {
      updatesByBot,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return {
      updatesByBot: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveState(state: TelegramProcessedUpdatesState): Promise<void> {
  await ensureDir();
  await fs.writeFile(
    PROCESSED_UPDATES_FILE,
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export async function claimTelegramUpdate(
  botId: string,
  updateId: number
): Promise<boolean> {
  if (!Number.isInteger(updateId)) {
    throw new Error("Telegram update_id must be an integer");
  }

  const normalizedBotId = normalizeBotId(botId);
  const state = await loadState();
  const updates = state.updatesByBot[normalizedBotId] ?? [];

  if (updates.includes(updateId)) {
    return false;
  }

  updates.push(updateId);
  if (updates.length > MAX_UPDATES_PER_BOT) {
    state.updatesByBot[normalizedBotId] = updates.slice(-MAX_UPDATES_PER_BOT);
  } else {
    state.updatesByBot[normalizedBotId] = updates;
  }
  state.updatedAt = new Date().toISOString();

  await saveState(state);
  return true;
}

export async function releaseTelegramUpdate(
  botId: string,
  updateId: number
): Promise<void> {
  if (!Number.isInteger(updateId)) {
    return;
  }

  const normalizedBotId = normalizeBotId(botId);
  const state = await loadState();
  const updates = state.updatesByBot[normalizedBotId] ?? [];
  const next = updates.filter((value) => value !== updateId);

  if (next.length === updates.length) {
    return;
  }

  state.updatesByBot[normalizedBotId] = next;
  state.updatedAt = new Date().toISOString();
  await saveState(state);
}
