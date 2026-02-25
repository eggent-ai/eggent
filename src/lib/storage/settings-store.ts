import fs from "fs/promises";
import path from "path";
import { AppSettings } from "@/lib/types";
import {
  DEFAULT_AUTH_PASSWORD_HASH,
  DEFAULT_AUTH_USERNAME,
} from "@/lib/auth/password";

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
    timeout: 180,
    maxOutputLength: 50000,
  },
  memory: {
    enabled: true,
    similarityThreshold: 0.35,
    maxResults: 10,
    chunkSize: 400,
  },
  search: {
    enabled: false,
    provider: "none",
  },
  general: {
    darkMode: false,
    language: "en",
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

export async function saveSettings(
  settings: Partial<AppSettings>
): Promise<AppSettings> {
  await ensureDir(SETTINGS_DIR);
  const current = await getSettings();
  const merged = deepMerge(current as unknown as Record<string, unknown>, settings as unknown as Record<string, unknown>) as unknown as AppSettings;
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
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
