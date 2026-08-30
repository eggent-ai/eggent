import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const EXTERNAL_SESSIONS_DIR = path.join(DATA_DIR, "external-sessions");
const GLOBAL_CONTEXT_KEY = "__global__";
const SESSION_ID_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;

export interface ExternalSession {
  id: string;
  activeProjectId: string | null;
  /**
   * The one conversation this session is having.
   *
   * It used to be a chat per project (`activeChats` below), which turned a
   * single Telegram thread into several hidden ones: asking to put a task in a
   * project moved the conversation to that project's chat, so the assistant no
   * longer knew what had just been said, and going back resumed the earlier
   * thread while everything said in the project stayed behind. In a messenger
   * there is no chat list and no way to choose, so the person could not even
   * see it happening - both threads are shown with the same title.
   *
   * One chat follows the person across projects instead, which is what the web
   * already does: the runtime resumes a session by chat id, so the history
   * carries over intact and only the working directory changes.
   */
  activeChatId?: string | null;
  /**
   * Legacy per-project chats, kept so an existing session can be carried over
   * rather than restarted. Written no more; read once, in sessionChatId().
   */
  activeChats: Record<string, string>;
  /** Where in the file tree this session is, per project. Genuinely per project. */
  currentPaths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * The chat this session is talking in, carrying an older split session over.
 *
 * For a session recorded before the change there is no single chat, so take the
 * one for the project it was last in - that is where the person was when they
 * stopped - and fall back to the orchestrator's, then to whatever exists.
 */
export function sessionChatId(session: ExternalSession): string | null {
  if (session.activeChatId) return session.activeChatId;
  const legacy = session.activeChats || {};
  const candidates = [
    contextKey(session.activeProjectId),
    GLOBAL_CONTEXT_KEY,
    ...Object.keys(legacy),
  ];
  for (const key of candidates) {
    if (legacy[key]) return legacy[key];
  }
  return null;
}

export function setSessionChatId(session: ExternalSession, chatId: string): void {
  session.activeChatId = chatId;
}

/**
 * May this named chat be used while working in this project?
 *
 * A caller that names some other chat should be told when it does not belong to
 * the project it asked to work in - that check exists to catch a mistake. But a
 * session's *own* chat now spans projects by design, so the same comparison
 * turned into a wall: the messenger passes the session chat explicitly whenever
 * a message carries an attachment, a voice message is an attachment, and anyone
 * speaking rather than typing was refused on the first thing they said after
 * the agent moved into a project.
 */
export function mayUseChatForProject(params: {
  session: ExternalSession;
  chatId: string;
  chatProjectId: string | null | undefined;
  requestedProjectId: string | null | undefined;
}): boolean {
  if (params.chatId === sessionChatId(params.session)) return true;
  return (params.chatProjectId ?? null) === (params.requestedProjectId ?? null);
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
      activeChatId: typeof parsed.activeChatId === "string" ? parsed.activeChatId : null,
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
    activeChatId: null,
    activeChats: {},
    currentPaths: {},
    createdAt: now,
    updatedAt: now,
  };
  await saveExternalSession(created);
  return created;
}

