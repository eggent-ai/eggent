import { runAgentText } from "@/lib/agent/agent";
import { createChat, getChat } from "@/lib/storage/chat-store";
import { getAllProjects, getProject } from "@/lib/storage/project-store";
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
  chatId?: string;
  currentPath?: string;
  runtimeData?: Record<string, unknown>;
}

interface SwitchProjectSignal {
  projectId: string;
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
    toProjectId: string;
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

  const projectId =
    typeof record.projectId === "string" ? record.projectId.trim() : "";
  if (!projectId) return null;

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

export async function handleExternalMessage(
  input: HandleExternalMessageInput
): Promise<ExternalMessageResult> {
  const sessionId = input.sessionId.trim();
  const message = input.message.trim();
  const explicitProjectId = input.projectId?.trim() ?? "";
  const explicitChatId = input.chatId?.trim() ?? "";
  const explicitCurrentPath =
    typeof input.currentPath === "string" ? input.currentPath : undefined;

  if (!sessionId) {
    throw new ExternalMessageError(400, { error: "sessionId is required" });
  }
  if (!message) {
    throw new ExternalMessageError(400, { error: "message is required" });
  }

  const session = await getOrCreateExternalSession(sessionId);
  const projects = await getAllProjects();
  const projectById = new Map(projects.map((project) => [project.id, project]));
  if (session.activeProjectId && !projectById.has(session.activeProjectId)) {
    session.activeProjectId = null;
  }

  let resolvedProjectId: string | undefined;

  if (explicitProjectId) {
    if (!projectById.has(explicitProjectId)) {
      throw new ExternalMessageError(404, {
        error: `Project "${explicitProjectId}" not found`,
        availableProjects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      });
    }
    resolvedProjectId = explicitProjectId;
    session.activeProjectId = explicitProjectId;
  } else if (session.activeProjectId && projectById.has(session.activeProjectId)) {
    resolvedProjectId = session.activeProjectId;
  } else if (projects.length > 0) {
    resolvedProjectId = projects[0].id;
    session.activeProjectId = projects[0].id;
  }

  const contextId = contextKey(resolvedProjectId);
  const currentPath =
    explicitCurrentPath ??
    session.currentPaths[contextId] ??
    "";

  let resolvedChatId: string;
  if (explicitChatId) {
    const explicitChat = await getChat(explicitChatId);
    if (!explicitChat) {
      throw new ExternalMessageError(404, {
        error: `Chat "${explicitChatId}" not found`,
      });
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
      if (
        sessionChat &&
        chatBelongsToProject(sessionChat.projectId, resolvedProjectId)
      ) {
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

  const reply = await runAgentText({
    chatId: resolvedChatId,
    userMessage: message,
    projectId: resolvedProjectId,
    currentPath: currentPath || undefined,
    runtimeData: input.runtimeData,
  });

  const afterChat = await getChat(resolvedChatId);
  const newMessages = afterChat?.messages.slice(beforeCount) ?? [];

  let switchSignal: SwitchProjectSignal | null = null;
  let createSignal: CreateProjectSignal | null = null;
  for (let i = newMessages.length - 1; i >= 0; i -= 1) {
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

  if (switchSignal && projectByIdAfter.has(switchSignal.projectId)) {
    activeProjectId = switchSignal.projectId;
    session.activeProjectId = switchSignal.projectId;
    const switchedContextKey = contextKey(switchSignal.projectId);
    session.currentPaths[switchedContextKey] = switchSignal.currentPath ?? "";
    activeCurrentPath = switchSignal.currentPath ?? "";
    activeChatId = await ensureChatForProject(session, switchSignal.projectId);
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
      switchSignal && projectByIdAfter.has(switchSignal.projectId)
        ? {
            toProjectId: switchSignal.projectId,
            toProjectName:
              projectByIdAfter.get(switchSignal.projectId)?.name ?? null,
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
