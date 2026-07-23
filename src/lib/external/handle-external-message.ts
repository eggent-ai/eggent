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
import type { ChatMessage } from "@/lib/types";

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

function parseSwitchProjectSignal(
  message: ChatMessage
): SwitchProjectSignal | null {
  if (message.role !== "tool" || message.toolName !== "switch_project") {
    return null;
  }

  let parsed: unknown = message.toolResult ?? message.content;
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

  let parsed: unknown = message.toolResult ?? message.content;
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
  projectId: string | undefined
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
  const title = `External session ${session.id}`;
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
  const sessionId = input.sessionId.trim();
  const explicitProjectId = input.projectId?.trim() ?? "";
  const explicitProjectName = input.projectName?.trim() ?? "";
  const explicitProjectRef = explicitProjectId || explicitProjectName;
  const explicitChatId = input.chatId?.trim() ?? "";
  const explicitCurrentPath =
    typeof input.currentPath === "string" && !input.publicMode ? input.currentPath : undefined;

  if (!sessionId) {
    throw new ExternalMessageError(400, { error: "sessionId is required" });
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
        error: `Project name "${explicitProjectRef}" is ambiguous. Use projectId instead.`,
        availableProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      });
    }
    if (!resolvedProject.project) {
      throw new ExternalMessageError(404, {
        error: `Project "${explicitProjectRef}" not found`,
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
      throw new ExternalMessageError(404, { error: `Chat "${explicitChatId}" not found` });
    }
    if (!chatBelongsToProject(explicitChat.projectId, resolvedProjectId)) {
      throw new ExternalMessageError(409, {
        error:
          'Provided chatId belongs to a different project context. Send matching chatId/projectId or omit chatId.',
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
        resolvedChatId = await ensureChatForProject(session, resolvedProjectId);
      }
    } else {
      resolvedChatId = await ensureChatForProject(session, resolvedProjectId);
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
          "This is a public shared project chat. Stay within the locked project. Do not switch projects, create projects, list other projects, or reveal unrelated workspace details.",
      }
    : input.runtimeData;

  return { session, resolvedProjectId, currentPath, resolvedChatId, beforeCount, runtimeData };
}

function sanitizeExternalFileName(value: string): string {
  const safe = value.trim().replace(/[\\/]+/g, "_");
  return safe || `telegram-file-${Date.now()}`;
}

export async function handleExternalMessage(
  input: HandleExternalMessageInput
): Promise<ExternalMessageResult> {
  const message = input.message.trim();
  if (!message) {
    throw new ExternalMessageError(400, { error: "message is required" });
  }

  const {
    session,
    resolvedProjectId,
    currentPath,
    resolvedChatId,
    beforeCount,
    runtimeData,
  } = await resolveExternalMessageRunContext(input);

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
    activeChatId = await ensureChatForProject(session, switchSignal.projectId ?? undefined);
  } else if (createSignal && projectByIdAfter.has(createSignal.projectId)) {
    activeProjectId = createSignal.projectId;
    session.activeProjectId = createSignal.projectId;
    const createdContextKey = contextKey(createSignal.projectId);
    session.currentPaths[createdContextKey] = "";
    activeCurrentPath = "";
    activeChatId = await ensureChatForProject(session, createSignal.projectId);
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
      message: isVoice ? effectiveMessage : `${effectiveMessage}\n\nAttached file: ${saved.name}`,
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
    reply: `File "${saved.name}" saved to chat files.`,
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
