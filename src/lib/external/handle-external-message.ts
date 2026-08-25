import { runPiAgentText } from "@/lib/pi/chat-runner";
import { createChat, getChat } from "@/lib/storage/chat-store";
import { saveChatFile } from "@/lib/storage/chat-files-store";
import { getAllProjects, getProject } from "@/lib/storage/project-store";
import { transcribeAudioFile } from "@/lib/speech/transcriber";
import {
  contextKey,
  getOrCreateExternalSession,
  saveExternalSession,
  type ExternalSession,
} from "@/lib/storage/external-session-store";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";
import type { ChatMessage } from "@/lib/types";
import {
  rememberTelegramDestinationFromRuntime,
  type TelegramDestinationKind,
} from "@/lib/telegram/outbound";

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

export interface ExternalMessageResult {
  success: true;
  sessionId: string;
  reply: string;
  context: {
    activeProjectId: string | null;
    activeProjectName: string | null;
    activeChatId: string;
    currentPath: string;
  };
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

function chatBelongsToProject(
  chatProjectId: string | undefined,
  projectId: string | undefined
): boolean {
  const left = chatProjectId ?? null;
  const right = projectId ?? null;
  return left === right;
}

async function ensureChatForProject(
  session: ExternalSession,
  projectId: string | undefined,
  t: (key: MessageKey, values?: Record<string, string | number | boolean | null | undefined>) => string
): Promise<string> {
  const key = contextKey(projectId);
  const existingId = session.activeChats[key];
  if (existingId) {
    const existingChat = await getChat(existingId);
    if (existingChat && chatBelongsToProject(existingChat.projectId, projectId)) {
      return existingId;
    }
  }

  const newChatId = crypto.randomUUID();
  const title = t("api.external.sessionTitle", { sessionId: session.id });
  await createChat(newChatId, title, projectId);
  session.activeChats[key] = newChatId;
  return newChatId;
}

interface ResolvedExternalMessageRunContext {
  session: ExternalSession;
  resolvedProjectId?: string;
  currentPath: string;
  resolvedChatId: string;
  beforeCount: number;
  runtimeData?: Record<string, unknown>;
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
    if (!chatBelongsToProject(explicitChat.projectId, resolvedProjectId)) {
      throw new ExternalMessageError(409, {
        error: t("api.error.chatProjectMismatch"),
      });
    }
    resolvedChatId = explicitChatId;
  } else {
    const sessionChatId = session.activeChats[contextId];
    if (sessionChatId) {
      const sessionChat = await getChat(sessionChatId);
      if (sessionChat && chatBelongsToProject(sessionChat.projectId, resolvedProjectId)) {
        resolvedChatId = sessionChatId;
      } else {
        resolvedChatId = await ensureChatForProject(session, resolvedProjectId, t);
      }
    } else {
      resolvedChatId = await ensureChatForProject(session, resolvedProjectId, t);
    }
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

  return { session, resolvedProjectId, currentPath, resolvedChatId, beforeCount, runtimeData };
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

  const {
    session,
    resolvedProjectId,
    currentPath,
    resolvedChatId,
    beforeCount,
    runtimeData,
  } = await resolveExternalMessageRunContext(input);

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
        currentPath: "",
      },
      switchedProject: { toProjectId: null, toProjectName: null },
      createdProject: null,
    };
  }

  // Remember where this came from, so a schedule or a later background run can
  // still reach the user once this request is over. A message forwarded by the
  // deployment's bot has to go back out through the relay, because its token
  // does not belong to this workspace.
  await rememberTelegramDestinationFromRuntime(
    input.toolRuntimeData,
    input.telegramVia ?? "relay"
  );

  const reply = await runPiAgentText({
    chatId: resolvedChatId,
    userMessage: message,
    projectId: resolvedProjectId,
    cwd: currentPath || undefined,
    runtimeData,
    toolRuntimeData: input.toolRuntimeData,
    enableEggentTools: input.publicMode ? false : undefined,
  });

  const afterChat = await getChat(resolvedChatId);
  const newMessages = afterChat?.messages.slice(beforeCount) ?? [];

  let switchSignal: SwitchProjectSignal | null = null;
  let createSignal: CreateProjectSignal | null = null;
  for (let i = newMessages.length - 1; !input.publicMode && i >= 0; i -= 1) {
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

  if (switchSignal && (switchSignal.projectId === null || projectByIdAfter.has(switchSignal.projectId))) {
    activeProjectId = switchSignal.projectId;
    session.activeProjectId = switchSignal.projectId;
    const switchedContextKey = contextKey(switchSignal.projectId);
    session.currentPaths[switchedContextKey] = switchSignal.currentPath ?? "";
    activeCurrentPath = switchSignal.currentPath ?? "";
    const t = await getServerTranslator();
    activeChatId = await ensureChatForProject(session, switchSignal.projectId ?? undefined, t);
  } else if (createSignal && projectByIdAfter.has(createSignal.projectId)) {
    activeProjectId = createSignal.projectId;
    session.activeProjectId = createSignal.projectId;
    const createdContextKey = contextKey(createSignal.projectId);
    session.currentPaths[createdContextKey] = "";
    activeCurrentPath = "";
    const t = await getServerTranslator();
    activeChatId = await ensureChatForProject(session, createSignal.projectId, t);
  } else {
    if (resolvedProjectId) {
      session.activeProjectId = resolvedProjectId;
    }
    session.currentPaths[contextId] = currentPath;
    session.activeChats[contextId] = resolvedChatId;
  }

  const activeContextKey = contextKey(activeProjectId ?? undefined);
  session.activeChats[activeContextKey] = activeChatId;
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
      currentPath: activeCurrentPath,
    },
    switchedProject:
      switchSignal && (switchSignal.projectId === null || projectByIdAfter.has(switchSignal.projectId))
        ? {
            toProjectId: switchSignal.projectId,
            toProjectName: switchSignal.projectId
              ? projectByIdAfter.get(switchSignal.projectId)?.name ?? null
              : "Orchestrator",
          }
        : null,
    createdProject:
      createSignal && projectByIdAfter.has(createSignal.projectId)
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
    const transcription = await transcribeAudioFile({
      filePath: saved.path,
      filename: saved.name,
      mimeType: input.file.mimeType,
    });
    effectiveMessage = [
      incomingMessage ? `Комментарий к голосовому: ${incomingMessage}` : "",
      `🎙 Голосовое сообщение:\n${transcription.transcript}`,
    ].filter(Boolean).join("\n\n");
  }

  if (effectiveMessage) {
    return handleExternalMessage({
      ...input,
      message: isVoice ? effectiveMessage : `${effectiveMessage}\n\n${(await getServerTranslator())("api.external.attachedFile", { name: saved.name })}`,
      projectId: context.resolvedProjectId,
      chatId: context.resolvedChatId,
      currentPath: context.currentPath,
    });
  }

  const activeProjectId = context.resolvedProjectId ?? null;
  const activeContextKey = contextKey(context.resolvedProjectId);
  context.session.activeChats[activeContextKey] = context.resolvedChatId;
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
      currentPath: context.currentPath,
    },
    switchedProject: null,
    createdProject: null,
  };
}
