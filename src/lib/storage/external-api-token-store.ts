import fs from "fs/promises";
import path from "path";
import { randomBytes } from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_DIR = path.join(DATA_DIR, "settings");
const TOKEN_FILE = path.join(SETTINGS_DIR, "external-api-token.json");

interface ExternalApiTokenRecord {
  token: string;
  createdAt: string;
  updatedAt: string;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return `${token.slice(0, 6)}****${token.slice(-4)}`;
}

export async function getExternalApiToken(): Promise<string | null> {
  await ensureDir(SETTINGS_DIR);
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExternalApiTokenRecord>;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    return token || null;
  } catch {
    return null;
  }
}

export async function getExternalApiTokenStatus(): Promise<{
  configured: boolean;
  maskedToken: string | null;
  updatedAt: string | null;
}> {
  await ensureDir(SETTINGS_DIR);
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExternalApiTokenRecord>;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    if (!token) {
      return {
        configured: false,
        maskedToken: null,
        updatedAt,
      };
    }
    return {
      configured: true,
      maskedToken: maskToken(token),
      updatedAt,
    };
  } catch {
    return {
      configured: false,
      maskedToken: null,
      updatedAt: null,
    };
  }
}

export async function saveExternalApiToken(token: string): Promise<void> {
  const value = token.trim();
  if (!value) {
    throw new Error("Token must not be empty");
  }

  await ensureDir(SETTINGS_DIR);
  const now = new Date().toISOString();

  let createdAt = now;
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExternalApiTokenRecord>;
    if (typeof parsed.createdAt === "string" && parsed.createdAt) {
      createdAt = parsed.createdAt;
    }
  } catch {
    // Keep default createdAt.
  }

  const next: ExternalApiTokenRecord = {
    token: value,
    createdAt,
    updatedAt: now,
  };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(next, null, 2), "utf-8");
}

export function generateExternalApiToken(): string {
  return `eggent_ext_${randomBytes(32).toString("hex")}`;
}

export function maskExternalApiToken(token: string): string {
  return maskToken(token);
}
