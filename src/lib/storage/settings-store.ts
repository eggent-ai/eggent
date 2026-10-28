import fs from "fs/promises";
import path from "path";
import type { AppSettings } from "@/lib/types";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
} from "@/lib/auth/password";
import { normalizeLocalePreference } from "@/i18n/locales";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export const DEFAULT_SETTINGS: AppSettings = {
  chatModel: {
    provider: "openai",
    model: "gpt-4o",
    authMethod: "api_key",
    temperature: 0.7,
    maxTokens: 4096,
  },
  utilityModel: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 2048,
  },
  embeddingsModel: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  codeExecution: {
    enabled: true,
    timeout: 600,
    maxOutputLength: 120000,
  },
  memory: {
    enabled: true,
    similarityThreshold: 0.35,
    maxResults: 10,
    chunkSize: 400,
  },
  search: {
    enabled: true,
    provider: "auto",
  },
  general: {
    darkMode: false,
    language: normalizeLocalePreference(process.env.EGGENT_DEFAULT_LANGUAGE),
  },
  learning: {
    enabled: true,
  },
  fileHistory: {
    enabled: true,
  },
  auth: {
    enabled: true,
    username: DEFAULT_AUTH_USERNAME,
    passwordHash: DEFAULT_AUTH_PASSWORD_HASH,
    mustChangeCredentials: true,
  },
};

export async function getSettings(): Promise<AppSettings> {
  await ensureDir(SETTINGS_DIR);
  try {
    const content = await fs.readFile(SETTINGS_FILE, "utf-8");
    const saved = JSON.parse(content) as unknown;
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    // Deep merge with defaults to handle new nested fields.
    return deepMerge(
      structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>,
      saved as Record<string, unknown>
    ) as unknown as AppSettings;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

// One writer at a time, in this process and in anything else that writes this
// file: a hosted workspace's password reset runs a script inside the container
// that takes the same lock. Every writer reads the file again inside it, so a
// write that began before a new password cannot put the old one back.
const LOCK_DIR = path.join(SETTINGS_DIR, ".lock");
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

async function withSettingsLock<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Left by a writer that died holding it.
      const stat = await fs.stat(LOCK_DIR).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rmdir(LOCK_DIR).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error("The settings are being written by something else; try again.");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await work();
  } finally {
    await fs.rmdir(LOCK_DIR).catch(() => undefined);
  }
}

/** The session that asked for a write was ended (a new password) while the write waited. */
export class SessionEndedError extends Error {}

export async function saveSettings(
  settings: Partial<AppSettings>,
  options: { sessionIssuedAt?: number } = {}
): Promise<AppSettings> {
  await ensureDir(SETTINGS_DIR);
  return withSettingsLock(async () => {
    const current = await getSettings();
    const floor = current.auth.sessionsValidAfter ?? 0;
    if (options.sessionIssuedAt !== undefined && floor > options.sessionIssuedAt) {
      throw new SessionEndedError("The session that asked for this has been ended.");
    }
    const merged = deepMerge(current as unknown as Record<string, unknown>, settings as unknown as Record<string, unknown>) as unknown as AppSettings;
    // The moment sessions were last ended only moves forward.
    const nextFloor = Math.max(floor, merged.auth.sessionsValidAfter ?? 0);
    if (nextFloor > 0) merged.auth.sessionsValidAfter = nextFloor;
    // Whole or not at all: a reader never meets half a file, which reads back
    // as no settings and so as the default login.
    const temporary = `${SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temporary, JSON.stringify(merged, null, 2), "utf-8");
    await fs.rename(temporary, SETTINGS_FILE);
    return merged;
  });
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
