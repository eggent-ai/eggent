import { joinActiveRun, runPiAgentText } from "@/lib/pi/chat-runner";
import { createChat, getChat } from "@/lib/storage/chat-store";
import { saveChatFile } from "@/lib/storage/chat-files-store";
import { getAllProjects, getProject } from "@/lib/storage/project-store";
import { transcribeVoiceNote } from "@/lib/speech/voice-note";
import {
  contextKey,
  getOrCreateExternalSession,
  saveExternalSession,
  mayUseChatForProject,
  sessionChatId,
  setSessionChatId,
  type ExternalSession,
} from "@/lib/storage/external-session-store";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";
import type { AgentProgressEvent } from "@/lib/pi/types";
import type { ChatContextMode } from "@/lib/types";
import type { ChatMessage } from "@/lib/types";
import {
  rememberTelegramDestinationFromRuntime,
  type TelegramDestinationKind,
} from "@/lib/telegram/outbound";
import {
  chatForTelegramMessage,
  moveSessionToChat,
  RELAY_BOT_KEY,
} from "@/lib/telegram/conversation";
import {
  chatShortId,
  findChatByShortId,
  lastConversationLine,
  listChatSummaries,
} from "@/lib/storage/chat-browse";

export interface HandleExternalMessageInput {
  sessionId: string;
  message: string;
  projectId?: string;
  projectName?: string;
  chatId?: string;
  currentPath?: string;
  runtimeData?: Record<string, unknown>;
  toolRuntimeData?: Record<string, unknown>;
  publicMode?: boolean;
  /** Who owns the bot this message arrived through. Defaults to the relay. */
  telegramVia?: TelegramDestinationKind;
  /**
   * The Telegram message this one replies to. The reply goes to the chat that
   * message came from, whichever chat the conversation was in.
   */
  telegramReplyToMessageId?: number;
  /** Which bot numbered that message; the deployment's relay unless said. */
  telegramBotKey?: string;
  /**
   * The chat the conversation was in before this message, for a caller that
   * moved it first - so the answer can still say that it moved.
   */
  previousChatId?: string | null;
  /** Told about the answer while it is being written, for a surface that shows it. */
  onProgress?: (event: AgentProgressEvent) => void;
}

export interface HandleExternalMediaMessageInput extends HandleExternalMessageInput {
  file: {
    buffer: Buffer;
    filename: string;
    mimeType?: string;
    kind?: "document" | "photo" | "audio" | "video" | "voice" | "file";
  };
}

interface SwitchProjectSignal {
  projectId: string | null;
  currentPath: string;
}

interface CreateProjectSignal {
  projectId: string;
}

interface SwitchChatSignal {
  chatId: string;
}

export interface ExternalMessageResult {
  success: true;
  sessionId: string;
  reply: string;
  context: {
    activeProjectId: string | null;
    activeProjectName: string | null;
    activeChatId: string;
    /** What the chat is called, for a surface that has to say where it is. */
    activeChatTitle: string | null;
    currentPath: string;
  };
  /**
   * The conversation is in a different chat from the one it was in before this
   * message: a reply reached back to an older one, or the agent moved it.
   * A messenger has no chat list, so the answer should say where it now is.
   */
  chatChanged: boolean;
  switchedProject: {
    toProjectId: string | null;
    toProjectName: string | null;
  } | null;
  createdProject: {
    id: string;
    name: string | null;
  } | null;
}

export class ExternalMessageError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(
      typeof payload.error === "string"
        ? payload.error
        : `External message failed with status ${status}`
    );
    this.status = status;
    this.payload = payload;
  }
}

/** The status and body the JSON routes answer a failed turn with. */
export function describeExternalError(
  error: unknown,
  fallback: string
): { status: number; payload: Record<string, unknown> } {
  if (error instanceof ExternalMessageError) {
    return { status: error.status, payload: error.payload };
  }
  return { status: 500, payload: { error: error instanceof Error ? error.message : fallback } };
}

function unwrapToolResultPayload(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.success !== undefined || record.action !== undefined) return value;
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const part of record.content) {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const partRecord = part as Record<string, unknown>;
        if (partRecord.type === "text" && typeof partRecord.text === "string") {
          texts.push(partRecord.text);
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return value;
}

function parseSwitchProjectSignal(
  message: ChatMessage
): SwitchProjectSignal | null {
  if (message.role !== "tool" || message.toolName !== "switch_project") {
    return null;
  }

  let parsed: unknown = unwrapToolResultPayload(message.toolResult) ?? message.content;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.success !== true || record.action !== "switch_project") {
    return null;
  }

  const rawProjectId =
    typeof record.projectId === "string" ? record.projectId.trim() : "";
  if (!rawProjectId) return null;
  const projectId = rawProjectId === "none" ? null : rawProjectId;

  const currentPath =
    typeof record.currentPath === "string" ? record.currentPath : "";

  return { projectId, currentPath };
}

function parseCreateProjectSignal(
  message: ChatMessage
): CreateProjectSignal | null {
  if (message.role !== "tool" || message.toolName !== "create_project") {
    return null;
  }

  let parsed: unknown = unwrapToolResultPayload(message.toolResult) ?? message.content;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.success !== true || record.action !== "create_project") {
    return null;
  }

  const projectId =
    typeof record.projectId === "string" ? record.projectId.trim() : "";
  if (!projectId) return null;

  return { projectId };
}

function parseToolPayload(message: ChatMessage): Record<string, unknown> | null {
  let parsed: unknown = unwrapToolResultPayload(message.toolResult) ?? message.content;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseSwitchChatSignal(message: ChatMessage): SwitchChatSignal | null {
  if (message.role !== "tool" || message.toolName !== "eggent_manage_chats") return null;
  const record = parseToolPayload(message);
  if (!record || record.success !== true || record.action !== "switch_chat") return null;
  const chatId = typeof record.chatId === "string" ? record.chatId.trim() : "";
  return chatId ? { chatId } : null;
}

function normalizeProjectLookup(value: string): string {
  return value.trim().toLowerCase();
}

function resolveProjectByIdOrName(
  projects: Awaited<ReturnType<typeof getAllProjects>>,
  value: string
) {
  const lookup = value.trim();
  if (!lookup) return { project: null, ambiguous: false };

  const byId = projects.find((project) => project.id === lookup);
  if (byId) return { project: byId, ambiguous: false };

  const normalized = normalizeProjectLookup(lookup);
  const byName = projects.filter(
    (project) => normalizeProjectLookup(project.name) === normalized
  );
  if (byName.length === 1) return { project: byName[0], ambiguous: false };
  if (byName.length > 1) return { project: null, ambiguous: true };

  return { project: null, ambiguous: false };
}

/**
 * The chat this session is talking in, whichever project it is working in.
 *
 * A session used to hold one chat per project, so moving into a project moved
 * the conversation with it and left the history behind. See ExternalSession.
 */
async function ensureSessionChat(
  session: ExternalSession,
  projectId: string | undefined,
  t: (key: MessageKey, values?: Record<string, string | number | boolean | null | undefined>) => string
): Promise<string> {
  const existingId = sessionChatId(session);
  if (existingId && (await getChat(existingId))) {
    setSessionChatId(session, existingId);
    return existingId;
  }

  const newChatId = crypto.randomUUID();
  const title = t("api.external.sessionTitle", { sessionId: session.id });
  await createChat(newChatId, title, projectId);
  setSessionChatId(session, newChatId);
  return newChatId;
}

interface ResolvedExternalMessageRunContext {
  session: ExternalSession;
  /** The chat the conversation was in when this message arrived. */
  previousChatId: string | null;
  resolvedProjectId?: string;
  currentPath: string;
  resolvedChatId: string;
  beforeCount: number;
  runtimeData?: Record<string, unknown>;
  /** Whatever the chat was opened with; absent means the full workspace. */
  chatContextMode?: ChatContextMode;
}

async function resolveExternalMessageRunContext(
  input: HandleExternalMessageInput
): Promise<ResolvedExternalMessageRunContext> {
  const t = await getServerTranslator();
  const sessionId = input.sessionId.trim();
  const explicitProjectId = input.projectId?.trim() ?? "";
  const explicitProjectName = input.projectName?.trim() ?? "";
  const explicitProjectRef = explicitProjectId || explicitProjectName;
  const explicitChatId = input.chatId?.trim() ?? "";
  const explicitCurrentPath =
    typeof input.currentPath === "string" && !input.publicMode ? input.currentPath : undefined;

  if (!sessionId) {
    throw new ExternalMessageError(400, { error: t("api.error.sessionIdRequired") });
  }

  const session = await getOrCreateExternalSession(sessionId);
  const previousChatId = input.previousChatId !== undefined ? input.previousChatId : sessionChatId(session);

  // A reply continues the chat the replied-to message came from - this
  // morning's report, or an answer from last week - and the conversation stays
  // there afterwards, together with that chat's project. Saved at once: a file
  // that arrives with the reply re-reads the session before it runs.
  if (!explicitChatId && input.telegramReplyToMessageId) {
    const telegramChatId = telegramChatIdOf(input.toolRuntimeData);
    const replyChatId = telegramChatId === null
      ? null
      : await chatForTelegramMessage({
          botKey: input.telegramBotKey || RELAY_BOT_KEY,
          telegramChatId,
          messageId: input.telegramReplyToMessageId,
        });
    const replyChat = replyChatId ? await getChat(replyChatId) : null;
    if (replyChat && replyChat.id !== sessionChatId(session)) {
      moveSessionToChat(session, replyChat);
      session.updatedAt = new Date().toISOString();
      await saveExternalSession(session);
    }
  }

  const projects = await getAllProjects();
  const projectById = new Map(projects.map((project) => [project.id, project]));
  if (session.activeProjectId && !projectById.has(session.activeProjectId)) {
    session.activeProjectId = null;
  }

  let resolvedProjectId: string | undefined;

  if (explicitProjectRef) {
    const resolvedProject = resolveProjectByIdOrName(projects, explicitProjectRef);
    if (resolvedProject.ambiguous) {
      throw new ExternalMessageError(409, {
        error: t("api.error.projectNameAmbiguous", { project: explicitProjectRef }),
        availableProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      });
    }
    if (!resolvedProject.project) {
      throw new ExternalMessageError(404, {
        error: t("api.error.projectRefNotFound", { project: explicitProjectRef }),
        availableProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      });
    }
    resolvedProjectId = resolvedProject.project.id;
    session.activeProjectId = resolvedProject.project.id;
  } else if (session.activeProjectId && projectById.has(session.activeProjectId)) {
    resolvedProjectId = session.activeProjectId;
  }

  const contextId = contextKey(resolvedProjectId);
  const currentPath = explicitCurrentPath ?? session.currentPaths[contextId] ?? "";

  let resolvedChatId: string;
  if (explicitChatId) {
    const explicitChat = await getChat(explicitChatId);
    if (!explicitChat) {
      throw new ExternalMessageError(404, { error: t("api.error.chatNotFound", { chatId: explicitChatId }) });
    }
    if (
      !mayUseChatForProject({
        session,
        chatId: explicitChatId,
        chatProjectId: explicitChat.projectId,
        requestedProjectId: resolvedProjectId,
      })
    ) {
      throw new ExternalMessageError(409, {
        error: t("api.error.chatProjectMismatch"),
      });
    }
    resolvedChatId = explicitChatId;
  } else {
    // No project check: the session's chat is the conversation, and the project
    // it happens to be filed under is not a reason to start a new one.
    resolvedChatId = await ensureSessionChat(session, resolvedProjectId, t);
  }

  const beforeChat = await getChat(resolvedChatId);
  const beforeCount = beforeChat?.messages.length ?? 0;

  const runtimeData = input.publicMode
    ? {
        ...(input.runtimeData || {}),
        publicMode: true,
        lockedProjectId: resolvedProjectId || null,
        instructions:
          t("api.external.publicModeInstructions"),
      }
    : input.runtimeData;

  return {
    session,
    previousChatId,
    resolvedProjectId,
    currentPath,
    resolvedChatId,
    beforeCount,
    runtimeData,
    chatContextMode: beforeChat?.contextMode,
  };
}

function telegramChatIdOf(toolRuntimeData: Record<string, unknown> | undefined): string | number | null {
  const raw = toolRuntimeData?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const chatId = (raw as Record<string, unknown>).chatId;
  return typeof chatId === "string" || typeof chatId === "number" ? chatId : null;
}

/** Whether this message came in through a Telegram bot, ours or the deployment's. */
function isTelegramMessage(input: HandleExternalMessageInput): boolean {
  return Boolean(input.telegramVia) || telegramChatIdOf(input.toolRuntimeData) !== null;
}

async function chatTitle(chatId: string): Promise<string | null> {
  return (await getChat(chatId))?.title ?? null;
}

type ChatCommand = { kind: "list" } | { kind: "open"; shortId: string };

/**
 * The two chat commands a messenger needs, since it has no chat list: /chats
 * shows the recent ones, each with a /c_<id> command that opens it.
 *
 * Answered here rather than by the model, for the same reasons the project
 * button is: instant, free, and not dependent on the model choosing a tool.
 */
export function isChatCommand(message: string): boolean {
  return parseChatCommand(message) !== null;
}

function parseChatCommand(message: string): ChatCommand | null {
  const first = message.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const command = first.split("@", 1)[0];
  if (command === "/chats") return { kind: "list" };
  const open = /^\/c_([a-z0-9]{4,32})$/.exec(command);
  return open ? { kind: "open", shortId: open[1] } : null;
}

function formatAgo(
  iso: string,
  t: (key: MessageKey, values?: Record<string, string | number | boolean | null | undefined>) => string
): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return t("telegram.chats.justNow");
  if (minutes < 60) return t("telegram.chats.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("telegram.chats.hoursAgo", { count: hours });
  return t("telegram.chats.daysAgo", { count: Math.round(hours / 24) });
}

async function answerChatCommand(
  command: ChatCommand,
  context: ResolvedExternalMessageRunContext
): Promise<ExternalMessageResult> {
  const t = await getServerTranslator();
  const { session } = context;
  let reply: string;
  let activeChatId = context.resolvedChatId;
  let activeProjectId = context.resolvedProjectId ?? null;

  if (command.kind === "list") {
    const chats = await listChatSummaries({ limit: 10 });
    reply = chats.length === 0
      ? t("telegram.chats.empty")
      : [
          t("telegram.chats.title"),
          "",
          ...chats.map((chat) => {
            const where = [chat.projectName, formatAgo(chat.updatedAt, t)].filter(Boolean).join(" · ");
            const title = chat.title.length > 60 ? `${chat.title.slice(0, 59)}…` : chat.title;
            const current = chat.id === context.resolvedChatId ? ` ${t("telegram.chats.current")}` : "";
            return `${chat.scheduledJob ? "🕒" : "💬"} ${title}${current}\n   ${where ? `${where} · ` : ""}/c_${chatShortId(chat.id)}`;
          }),
          "",
          t("telegram.chats.hint"),
        ].join("\n");
  } else {
    const chat = await findChatByShortId(command.shortId);
    if (!chat) {
      reply = t("telegram.chats.notFound");
    } else {
      moveSessionToChat(session, chat);
      activeChatId = chat.id;
      activeProjectId = chat.projectId ?? null;
      const last = lastConversationLine(chat);
      reply = [
        t("telegram.chats.opened", { title: chat.title }),
        last ? t("telegram.chats.lastMessage", { text: last }) : "",
      ].filter(Boolean).join("\n\n");
    }
  }

  session.updatedAt = new Date().toISOString();
  await saveExternalSession(session);
  const activeProject = activeProjectId ? await getProject(activeProjectId) : null;
  return {
    success: true,
    sessionId: session.id,
    reply,
    context: {
      activeProjectId,
      activeProjectName: activeProject?.name ?? null,
      activeChatId,
      activeChatTitle: await chatTitle(activeChatId),
      currentPath: session.currentPaths[contextKey(activeProjectId)] ?? "",
    },
    // The command's own answer already names the chat.
    chatChanged: false,
    switchedProject: null,
    createdProject: null,
  };
}

function sanitizeExternalFileName(value: string): string {
  const safe = value.trim().replace(/[\\/]+/g, "_");
  return safe || `telegram-file-${Date.now()}`;
}

/**
 * True when this message is the Telegram exit-project button, not typed prose.
 *
 * Matched on the label's fixed part so renaming a project cannot orphan the
 * button. Only for messages arriving through a bot: the same words sent to the
 * external API by a program should still reach the agent.
 */
async function isExitProjectMessage(message: string, via: string | undefined): Promise<boolean> {
  if (!via) return false;
  const t = await getServerTranslator();
  const prefix = t("telegram.bot.exitProject", { project: "" }).trim();
  if (!prefix) return false;
  return message.trim().toLowerCase().startsWith(prefix.toLowerCase());
}

export async function handleExternalMessage(
  input: HandleExternalMessageInput
): Promise<ExternalMessageResult> {
  const message = input.message.trim();
  if (!message) {
    const t = await getServerTranslator();
    throw new ExternalMessageError(400, { error: t("api.error.messageRequired") });
  }

  const runContext = await resolveExternalMessageRunContext(input);
  const {
    session,
    previousChatId,
    resolvedProjectId,
    currentPath,
    resolvedChatId,
    beforeCount,
    runtimeData,
    chatContextMode,
  } = runContext;

  // Leaving a project is a state change in the interface, so it is answered
  // here rather than by running the model: it should be instant, it should not
  // cost a turn, and it should not depend on the model choosing to call the
  // tool. Handled at this level so both the workspace's own bot and the
  // deployment's shared one behave the same way.
  if (await isExitProjectMessage(message, input.telegramVia)) {
    session.activeProjectId = null;
    session.updatedAt = new Date().toISOString();
    await saveExternalSession(session);
    const t = await getServerTranslator();
    return {
      success: true,
      sessionId: session.id,
      reply: t("telegram.bot.leftProject"),
      context: {
        activeProjectId: null,
        activeProjectName: null,
        activeChatId: resolvedChatId,
        activeChatTitle: await chatTitle(resolvedChatId),
        currentPath: "",
      },
      chatChanged: false,
      switchedProject: { toProjectId: null, toProjectName: null },
      createdProject: null,
    };
  }

  // Remember where this came from, so a schedule or a later background run can
  // still reach the user once this request is over. A message forwarded by the
  // deployment's bot has to go back out through the relay, because its token
  // does not belong to this workspace. The session goes with it, so a delivery
  // knows which conversation to move.
  await rememberTelegramDestinationFromRuntime(
    input.toolRuntimeData,
    input.telegramVia ?? "relay",
    session.id
  );

  const chatCommand = isTelegramMessage(input) ? parseChatCommand(message) : null;
  if (chatCommand) return answerChatCommand(chatCommand, runContext);

  // A message sent while this chat is already working belongs to that run, not
  // to a second agent of its own. Over a messenger there is no stop button, so
  // the word is the only way to reach a turn in progress.
  const joined = await joinActiveRun(resolvedChatId, message);
  if (joined) {
    const t = await getServerTranslator();
    return {
      success: true,
      sessionId: session.id,
      reply: joined === "stopped" ? t("external.run.stopped") : t("external.run.steered"),
      context: {
        activeProjectId: resolvedProjectId || null,
        activeProjectName: null,
        activeChatId: resolvedChatId,
        activeChatTitle: await chatTitle(resolvedChatId),
        currentPath: currentPath || "",
      },
      chatChanged: Boolean(previousChatId) && resolvedChatId !== previousChatId,
      switchedProject: { toProjectId: null, toProjectName: null },
      createdProject: null,
    };
  }

  const reply = await runPiAgentText({
    chatId: resolvedChatId,
    userMessage: message,
    projectId: resolvedProjectId,
    // The mode belongs to the chat, not to the surface answering it: a light
    // chat opened in the web stays light when the next message arrives from
    // Telegram, instead of quietly costing forty times as much there.
    chatContextMode,
    cwd: currentPath || undefined,
    runtimeData,
    toolRuntimeData: input.toolRuntimeData,
    enableEggentTools: input.publicMode ? false : undefined,
    onProgress: input.onProgress,
  });

  const afterChat = await getChat(resolvedChatId);
  const newMessages = afterChat?.messages.slice(beforeCount) ?? [];

  let switchSignal: SwitchProjectSignal | null = null;
  let createSignal: CreateProjectSignal | null = null;
  let chatSignal: SwitchChatSignal | null = null;
  for (let i = newMessages.length - 1; !input.publicMode && i >= 0; i -= 1) {
    if (!chatSignal) {
      chatSignal = parseSwitchChatSignal(newMessages[i]);
    }
    if (!switchSignal) {
      const parsedSwitch = parseSwitchProjectSignal(newMessages[i]);
      if (parsedSwitch) {
        switchSignal = parsedSwitch;
      }
    }
    if (!createSignal) {
      const parsedCreate = parseCreateProjectSignal(newMessages[i]);
      if (parsedCreate) {
        createSignal = parsedCreate;
      }
    }
    if (switchSignal && createSignal) {
      break;
    }
  }

  const projectsAfter = await getAllProjects();
  const projectByIdAfter = new Map(
    projectsAfter.map((project) => [project.id, project])
  );

  let activeProjectId = resolvedProjectId ?? null;
  let activeChatId = resolvedChatId;
  let activeCurrentPath = currentPath;
  const contextId = contextKey(resolvedProjectId);
  // The agent moved the conversation to another chat: the person's next
  // message continues there, in that chat's project. It outranks a project
  // switch in the same turn, which a chat already implies.
  const switchedChat = chatSignal ? await getChat(chatSignal.chatId) : null;

  if (switchedChat) {
    session.currentPaths[contextId] = currentPath;
    moveSessionToChat(session, switchedChat);
    activeChatId = switchedChat.id;
    activeProjectId = switchedChat.projectId ?? null;
    activeCurrentPath = session.currentPaths[contextKey(activeProjectId)] ?? "";
  } else if (switchSignal && (switchSignal.projectId === null || projectByIdAfter.has(switchSignal.projectId))) {
    activeProjectId = switchSignal.projectId;
    session.activeProjectId = switchSignal.projectId;
    const switchedContextKey = contextKey(switchSignal.projectId);
    session.currentPaths[switchedContextKey] = switchSignal.currentPath ?? "";
    activeCurrentPath = switchSignal.currentPath ?? "";
    const t = await getServerTranslator();
    activeChatId = await ensureSessionChat(session, switchSignal.projectId ?? undefined, t);
  } else if (createSignal && projectByIdAfter.has(createSignal.projectId)) {
    activeProjectId = createSignal.projectId;
    session.activeProjectId = createSignal.projectId;
    const createdContextKey = contextKey(createSignal.projectId);
    session.currentPaths[createdContextKey] = "";
    activeCurrentPath = "";
    const t = await getServerTranslator();
    activeChatId = await ensureSessionChat(session, createSignal.projectId, t);
  } else {
    if (resolvedProjectId) {
      session.activeProjectId = resolvedProjectId;
    }
    session.currentPaths[contextId] = currentPath;
    setSessionChatId(session, resolvedChatId);
  }

  setSessionChatId(session, activeChatId);
  session.updatedAt = new Date().toISOString();
  await saveExternalSession(session);

  const activeProject = activeProjectId
    ? await getProject(activeProjectId)
    : null;

  return {
    success: true,
    sessionId: session.id,
    reply,
    context: {
      activeProjectId,
      activeProjectName: activeProject?.name ?? null,
      activeChatId,
      activeChatTitle: await chatTitle(activeChatId),
      currentPath: activeCurrentPath,
    },
    chatChanged: Boolean(previousChatId) && activeChatId !== previousChatId,
    switchedProject:
      !switchedChat && switchSignal && (switchSignal.projectId === null || projectByIdAfter.has(switchSignal.projectId))
        ? {
            toProjectId: switchSignal.projectId,
            toProjectName: switchSignal.projectId
              ? projectByIdAfter.get(switchSignal.projectId)?.name ?? null
              : "Orchestrator",
          }
        : null,
    createdProject:
      !switchedChat && createSignal && projectByIdAfter.has(createSignal.projectId)
        ? {
            id: createSignal.projectId,
            name: projectByIdAfter.get(createSignal.projectId)?.name ?? null,
          }
        : null,
  };
}

export async function handleExternalMediaMessage(
  input: HandleExternalMediaMessageInput
): Promise<ExternalMessageResult> {
  const context = await resolveExternalMessageRunContext(input);
  const saved = await saveChatFile(
    context.resolvedChatId,
    input.file.buffer,
    sanitizeExternalFileName(input.file.filename)
  );

  const incomingMessage = input.message.trim();
  const isVoice = input.file.kind === "voice";
  let effectiveMessage = incomingMessage;

  if (isVoice) {
    const transcript = await transcribeVoiceNote({
      chatId: context.resolvedChatId,
      filePath: saved.path,
      savedName: saved.name,
      mimeType: input.file.mimeType,
    });
    const tVoice = await getServerTranslator();
    effectiveMessage = [
      incomingMessage ? tVoice("chat.voice.comment", { text: incomingMessage }) : "",
      tVoice("chat.voice.transcript", { text: transcript }),
    ].filter(Boolean).join("\n\n");
  }

  if (effectiveMessage) {
    return handleExternalMessage({
      ...input,
      message: isVoice ? effectiveMessage : `${effectiveMessage}\n\n${(await getServerTranslator())("api.external.attachedFile", { name: saved.name })}`,
      projectId: context.resolvedProjectId,
      chatId: context.resolvedChatId,
      currentPath: context.currentPath,
      previousChatId: context.previousChatId,
    });
  }

  const activeProjectId = context.resolvedProjectId ?? null;
  const activeContextKey = contextKey(context.resolvedProjectId);
  setSessionChatId(context.session, context.resolvedChatId);
  context.session.currentPaths[activeContextKey] = context.currentPath;
  if (context.resolvedProjectId) context.session.activeProjectId = context.resolvedProjectId;
  context.session.updatedAt = new Date().toISOString();
  await saveExternalSession(context.session);

  const activeProject = activeProjectId ? await getProject(activeProjectId) : null;
  return {
    success: true,
    sessionId: context.session.id,
    reply: (await getServerTranslator())("api.external.fileSaved", { name: saved.name }),
    context: {
      activeProjectId,
      activeProjectName: activeProject?.name ?? null,
      activeChatId: context.resolvedChatId,
      activeChatTitle: await chatTitle(context.resolvedChatId),
      currentPath: context.currentPath,
    },
    chatChanged: Boolean(context.previousChatId) && context.resolvedChatId !== context.previousChatId,
    switchedProject: null,
    createdProject: null,
  };
}
