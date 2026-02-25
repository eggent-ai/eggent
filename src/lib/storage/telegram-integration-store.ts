import fs from "fs/promises";
import path from "path";
import { createHash, randomBytes } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
const TELEGRAM_SETTINGS_FILE = path.join(
  SETTINGS_DIR,
  "telegram-integration.json"
);

export type TelegramConfigSource = "stored" | "env" | "none";

interface TelegramAccessCodeRecord {
  hash: string;
  createdAt: string;
  expiresAt: string;
}

interface TelegramIntegrationFileRecord {
  botToken?: string;
  webhookSecret?: string;
  publicBaseUrl?: string;
  defaultProjectId?: string;
  allowedUserIds?: unknown;
  accessCodes?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface TelegramIntegrationStoredSettings {
  botToken: string;
  webhookSecret: string;
  publicBaseUrl: string;
  defaultProjectId: string;
  allowedUserIds: string[];
  accessCodes: TelegramAccessCodeRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface TelegramIntegrationRuntimeConfig {
  botToken: string;
  webhookSecret: string;
  publicBaseUrl: string;
  defaultProjectId: string;
  allowedUserIds: string[];
  sources: {
    botToken: TelegramConfigSource;
    webhookSecret: TelegramConfigSource;
  };
}

export interface TelegramGeneratedAccessCode {
  code: string;
  createdAt: string;
  expiresAt: string;
}

const TELEGRAM_ACCESS_CODE_DEFAULT_TTL_MINUTES = 30;
const TELEGRAM_ACCESS_CODE_MIN_TTL_MINUTES = 1;
const TELEGRAM_ACCESS_CODE_MAX_TTL_MINUTES = 24 * 60;

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTelegramUserId(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  const normalized = trimString(value);
  return /^-?\d+$/.test(normalized) ? normalized : "";
}

function normalizeDate(value: unknown): string {
  const raw = trimString(value);
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString();
}

function normalizeAllowedUserIds(raw: unknown): string[] {
  const inputValues = Array.isArray(raw) ? raw : [];
  const deduplicated = new Set<string>();
  for (const value of inputValues) {
    const normalized = normalizeTelegramUserId(value);
    if (normalized) {
      deduplicated.add(normalized);
    }
  }
  return Array.from(deduplicated).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function mergeAllowedUserIds(...sources: Array<readonly string[]>): string[] {
  const merged = new Set<string>();
  for (const source of sources) {
    for (const userId of source) {
      const normalized = normalizeTelegramUserId(userId);
      if (normalized) {
        merged.add(normalized);
      }
    }
  }
  return Array.from(merged).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function parseAllowedUserIdsFromEnv(raw: string): string[] {
  if (!raw) return [];
  return normalizeAllowedUserIds(raw.split(/[\s,]+/g).filter(Boolean));
}

function normalizeAccessCodeRecords(raw: unknown): TelegramAccessCodeRecord[] {
  const inputRecords = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  const deduplicated = new Map<string, TelegramAccessCodeRecord>();

  for (const value of inputRecords) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      hash?: unknown;
      createdAt?: unknown;
      expiresAt?: unknown;
    };

    const hash = trimString(entry.hash).toLowerCase();
    const createdAt = normalizeDate(entry.createdAt);
    const expiresAt = normalizeDate(entry.expiresAt);
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;

    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;

    deduplicated.set(hash, {
      hash,
      createdAt: createdAt || expiresAt,
      expiresAt,
    });
  }

  return Array.from(deduplicated.values()).sort((left, right) =>
    left.expiresAt.localeCompare(right.expiresAt)
  );
}

function parseAllowedUserIdsInput(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    return normalizeAllowedUserIds(raw);
  }
  if (typeof raw === "string") {
    return normalizeAllowedUserIds(raw.split(/[\s,]+/g).filter(Boolean));
  }
  throw new Error("allowedUserIds must be an array or string");
}

function hashAccessCode(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAccessCodeInput(value: string): string {
  const compact = value.trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(compact)) {
    return "";
  }
  return compact.toUpperCase();
}

function clampAccessCodeTtlMinutes(value: unknown): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : TELEGRAM_ACCESS_CODE_DEFAULT_TTL_MINUTES;
  return Math.max(
    TELEGRAM_ACCESS_CODE_MIN_TTL_MINUTES,
    Math.min(TELEGRAM_ACCESS_CODE_MAX_TTL_MINUTES, numeric)
  );
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("publicBaseUrl must use http:// or https://");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("publicBaseUrl must be a valid URL");
  }
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 10) return "****";
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function isMaskedValue(value: string): boolean {
  return value.includes("****");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
}

async function readStoredRecord(): Promise<TelegramIntegrationFileRecord> {
  await ensureDir();
  try {
    const raw = await fs.readFile(TELEGRAM_SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as TelegramIntegrationFileRecord;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStoredRecord(
  record: TelegramIntegrationFileRecord
): TelegramIntegrationStoredSettings {
  return {
    botToken: trimString(record.botToken),
    webhookSecret: trimString(record.webhookSecret),
    publicBaseUrl: trimString(record.publicBaseUrl),
    defaultProjectId: trimString(record.defaultProjectId),
    allowedUserIds: normalizeAllowedUserIds(record.allowedUserIds),
    accessCodes: normalizeAccessCodeRecords(record.accessCodes),
    createdAt: trimString(record.createdAt),
    updatedAt: trimString(record.updatedAt),
  };
}

async function writeStoredRecord(
  settings: TelegramIntegrationStoredSettings
): Promise<void> {
  await ensureDir();
  await fs.writeFile(
    TELEGRAM_SETTINGS_FILE,
    JSON.stringify(settings, null, 2),
    "utf-8"
  );
}

export async function getTelegramIntegrationStoredSettings(): Promise<TelegramIntegrationStoredSettings> {
  const record = await readStoredRecord();
  return normalizeStoredRecord(record);
}

export async function saveTelegramIntegrationStoredSettings(input: {
  botToken?: string;
  webhookSecret?: string;
  publicBaseUrl?: string;
  defaultProjectId?: string;
  allowedUserIds?: string[];
  accessCodes?: TelegramAccessCodeRecord[];
}): Promise<TelegramIntegrationStoredSettings> {
  const current = await getTelegramIntegrationStoredSettings();

  const nextBotToken =
    typeof input.botToken === "string" ? input.botToken.trim() : current.botToken;
  const nextWebhookSecret =
    typeof input.webhookSecret === "string"
      ? input.webhookSecret.trim()
      : current.webhookSecret;
  const nextPublicBaseUrl =
    typeof input.publicBaseUrl === "string"
      ? normalizeBaseUrl(input.publicBaseUrl)
      : current.publicBaseUrl;
  const nextDefaultProjectId =
    typeof input.defaultProjectId === "string"
      ? input.defaultProjectId.trim()
      : current.defaultProjectId;
  const nextAllowedUserIds =
    input.allowedUserIds !== undefined
      ? normalizeAllowedUserIds(input.allowedUserIds)
      : current.allowedUserIds;
  const nextAccessCodes =
    input.accessCodes !== undefined
      ? normalizeAccessCodeRecords(input.accessCodes)
      : current.accessCodes;

  const now = new Date().toISOString();
  const next: TelegramIntegrationStoredSettings = {
    botToken: nextBotToken,
    webhookSecret: nextWebhookSecret,
    publicBaseUrl: nextPublicBaseUrl,
    defaultProjectId: nextDefaultProjectId,
    allowedUserIds: nextAllowedUserIds,
    accessCodes: nextAccessCodes,
    createdAt: current.createdAt || now,
    updatedAt: now,
  };

  await writeStoredRecord(next);
  return next;
}

export async function getTelegramIntegrationRuntimeConfig(): Promise<TelegramIntegrationRuntimeConfig> {
  const stored = await getTelegramIntegrationStoredSettings();
  const envBotToken = trimString(process.env.TELEGRAM_BOT_TOKEN);
  const envWebhookSecret = trimString(process.env.TELEGRAM_WEBHOOK_SECRET);
  const envPublicBaseUrl = trimString(process.env.APP_BASE_URL);
  const envDefaultProjectId = trimString(process.env.TELEGRAM_DEFAULT_PROJECT_ID);
  const envAllowedUserIds = parseAllowedUserIdsFromEnv(
    trimString(process.env.TELEGRAM_ALLOWED_USER_IDS)
  );

  const botToken = stored.botToken || envBotToken;
  const webhookSecret = stored.webhookSecret || envWebhookSecret;
  const publicBaseUrl = stored.publicBaseUrl || envPublicBaseUrl;
  const defaultProjectId = stored.defaultProjectId || envDefaultProjectId;
  const allowedUserIds = mergeAllowedUserIds(
    stored.allowedUserIds,
    envAllowedUserIds
  );

  const botTokenSource: TelegramConfigSource = stored.botToken
    ? "stored"
    : envBotToken
      ? "env"
      : "none";
  const webhookSecretSource: TelegramConfigSource = stored.webhookSecret
    ? "stored"
    : envWebhookSecret
      ? "env"
      : "none";

  return {
    botToken,
    webhookSecret,
    publicBaseUrl,
    defaultProjectId,
    allowedUserIds,
    sources: {
      botToken: botTokenSource,
      webhookSecret: webhookSecretSource,
    },
  };
}

export async function getTelegramIntegrationPublicSettings(): Promise<{
  botToken: string;
  webhookSecret: string;
  publicBaseUrl: string;
  defaultProjectId: string;
  allowedUserIds: string[];
  pendingAccessCodes: number;
  updatedAt: string | null;
  sources: {
    botToken: TelegramConfigSource;
    webhookSecret: TelegramConfigSource;
  };
}> {
  const stored = await getTelegramIntegrationStoredSettings();
  const runtime = await getTelegramIntegrationRuntimeConfig();
  return {
    botToken: maskSecret(runtime.botToken),
    webhookSecret: maskSecret(runtime.webhookSecret),
    publicBaseUrl: runtime.publicBaseUrl,
    defaultProjectId: runtime.defaultProjectId,
    allowedUserIds: runtime.allowedUserIds,
    pendingAccessCodes: stored.accessCodes.length,
    updatedAt: stored.updatedAt || null,
    sources: runtime.sources,
  };
}

export async function saveTelegramIntegrationFromPublicInput(input: {
  botToken?: unknown;
  webhookSecret?: unknown;
  publicBaseUrl?: unknown;
  defaultProjectId?: unknown;
  allowedUserIds?: unknown;
}): Promise<void> {
  const currentStored = await getTelegramIntegrationStoredSettings();

  const tokenRaw =
    typeof input.botToken === "string" ? input.botToken.trim() : undefined;
  const secretRaw =
    typeof input.webhookSecret === "string"
      ? input.webhookSecret.trim()
      : undefined;

  const botToken =
    tokenRaw === undefined
      ? undefined
      : isMaskedValue(tokenRaw)
        ? currentStored.botToken
        : tokenRaw;
  const webhookSecret =
    secretRaw === undefined
      ? undefined
      : isMaskedValue(secretRaw)
        ? currentStored.webhookSecret
        : secretRaw;

  const publicBaseUrl =
    typeof input.publicBaseUrl === "string" ? input.publicBaseUrl : undefined;
  const defaultProjectId =
    typeof input.defaultProjectId === "string"
      ? input.defaultProjectId
      : undefined;
  const allowedUserIds = parseAllowedUserIdsInput(input.allowedUserIds);

  await saveTelegramIntegrationStoredSettings({
    botToken,
    webhookSecret,
    publicBaseUrl,
    defaultProjectId,
    allowedUserIds,
  });
}

export function generateTelegramAccessCode(): string {
  return `EG-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export async function createTelegramAccessCode(input?: {
  ttlMinutes?: unknown;
}): Promise<TelegramGeneratedAccessCode> {
  const ttlMinutes = clampAccessCodeTtlMinutes(input?.ttlMinutes);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const code = generateTelegramAccessCode();

  const settings = await getTelegramIntegrationStoredSettings();
  const nextAccessCodes: TelegramAccessCodeRecord[] = [
    ...settings.accessCodes,
    {
      hash: hashAccessCode(code),
      createdAt,
      expiresAt,
    },
  ];
  await saveTelegramIntegrationStoredSettings({
    accessCodes: nextAccessCodes,
  });

  return {
    code,
    createdAt,
    expiresAt,
  };
}

export async function consumeTelegramAccessCode(input: {
  code: string;
  userId: unknown;
}): Promise<boolean> {
  const normalizedUserId = normalizeTelegramUserId(input.userId);
  const normalizedCode = normalizeAccessCodeInput(input.code);
  if (!normalizedUserId || !normalizedCode) {
    return false;
  }

  const settings = await getTelegramIntegrationStoredSettings();
  const activeAccessCodes = normalizeAccessCodeRecords(settings.accessCodes);
  const codeHash = hashAccessCode(normalizedCode);
  const matchedIndex = activeAccessCodes.findIndex((item) => item.hash === codeHash);
  const hadExpiredCodes = activeAccessCodes.length !== settings.accessCodes.length;

  if (matchedIndex < 0) {
    if (hadExpiredCodes) {
      await saveTelegramIntegrationStoredSettings({
        accessCodes: activeAccessCodes,
      });
    }
    return false;
  }

  activeAccessCodes.splice(matchedIndex, 1);
  await saveTelegramIntegrationStoredSettings({
    allowedUserIds: mergeAllowedUserIds(settings.allowedUserIds, [normalizedUserId]),
    accessCodes: activeAccessCodes,
  });
  return true;
}

export function buildTelegramWebhookUrl(publicBaseUrl: string): string {
  const base = normalizeBaseUrl(publicBaseUrl);
  if (!base) {
    throw new Error("publicBaseUrl is required");
  }
  return `${base}/api/integrations/telegram`;
}

export function generateTelegramWebhookSecret(): string {
  return `eggent_tg_${randomBytes(24).toString("hex")}`;
}
