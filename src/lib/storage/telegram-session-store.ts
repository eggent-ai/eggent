import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const INTEGRATIONS_DIR = path.join(DATA_DIR, "integrations");
const TELEGRAM_DIR = path.join(INTEGRATIONS_DIR, "telegram");
const CHAT_SESSIONS_FILE = path.join(TELEGRAM_DIR, "chat-sessions.json");

interface TelegramChatSessionsState {
  sessions: Record<string, string>;
  updatedAt: string;
}

function normalizeBotId(botId: string): string {
  const value = botId.trim();
  if (!value) return "default";
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128) || "default";
}

function chatKey(botId: string, chatId: string | number): string {
  return `${normalizeBotId(botId)}:${String(chatId).trim()}`;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(TELEGRAM_DIR, { recursive: true });
}

async function loadState(): Promise<TelegramChatSessionsState> {
  await ensureDir();
  try {
    const raw = await fs.readFile(CHAT_SESSIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelegramChatSessionsState>;
    const sessions =
      parsed.sessions && typeof parsed.sessions === "object"
        ? parsed.sessions
        : {};
    return {
      sessions,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return {
      sessions: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveState(state: TelegramChatSessionsState): Promise<void> {
  await ensureDir();
  await fs.writeFile(CHAT_SESSIONS_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function createDefaultTelegramSessionId(
  botId: string,
  chatId: string | number
): string {
  return `telegram:${normalizeBotId(botId)}:${String(chatId).trim()}`;
}

export function createFreshTelegramSessionId(
  botId: string,
  chatId: string | number
): string {
  const nonce = randomUUID().replace(/-/g, "");
  return `${createDefaultTelegramSessionId(botId, chatId)}:${nonce}`;
}

export async function getTelegramChatSessionId(
  botId: string,
  chatId: string | number
): Promise<string | null> {
  const state = await loadState();
  const value = state.sessions[chatKey(botId, chatId)];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function setTelegramChatSessionId(
  botId: string,
  chatId: string | number,
  sessionId: string
): Promise<void> {
  const value = sessionId.trim();
  if (!value) {
    throw new Error("sessionId must not be empty");
  }

  const state = await loadState();
  state.sessions[chatKey(botId, chatId)] = value;
  state.updatedAt = new Date().toISOString();
  await saveState(state);
}
