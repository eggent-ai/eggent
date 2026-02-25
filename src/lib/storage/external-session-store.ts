import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const EXTERNAL_SESSIONS_DIR = path.join(DATA_DIR, "external-sessions");
const GLOBAL_CONTEXT_KEY = "__global__";
const SESSION_ID_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;

export interface ExternalSession {
  id: string;
  activeProjectId: string | null;
  activeChats: Record<string, string>;
  currentPaths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

function normalizeSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!SESSION_ID_REGEX.test(value)) {
    throw new Error(
      "sessionId must match /^[a-zA-Z0-9._:-]{1,128}$/"
    );
  }
  return value;
}

function sessionFilePath(sessionId: string): string {
  const safeId = normalizeSessionId(sessionId);
  return path.join(EXTERNAL_SESSIONS_DIR, `${safeId}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(EXTERNAL_SESSIONS_DIR, { recursive: true });
}

export function contextKey(projectId?: string | null): string {
  return projectId?.trim() ? projectId : GLOBAL_CONTEXT_KEY;
}

export async function getExternalSession(
  sessionId: string
): Promise<ExternalSession | null> {
  const filePath = sessionFilePath(sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ExternalSession;
    return {
      id: parsed.id,
      activeProjectId: parsed.activeProjectId ?? null,
      activeChats:
        parsed.activeChats && typeof parsed.activeChats === "object"
          ? parsed.activeChats
          : {},
      currentPaths:
        parsed.currentPaths && typeof parsed.currentPaths === "object"
          ? parsed.currentPaths
          : {},
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function saveExternalSession(
  session: ExternalSession
): Promise<void> {
  await ensureDir();
  const filePath = sessionFilePath(session.id);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
}

export async function getOrCreateExternalSession(
  sessionId: string
): Promise<ExternalSession> {
  const normalizedId = normalizeSessionId(sessionId);
  const existing = await getExternalSession(normalizedId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const created: ExternalSession = {
    id: normalizedId,
    activeProjectId: null,
    activeChats: {},
    currentPaths: {},
    createdAt: now,
    updatedAt: now,
  };
  await saveExternalSession(created);
  return created;
}

