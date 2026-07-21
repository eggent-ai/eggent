import "@/lib/pi/env";
import fs from "fs";
import path from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createEggentPiTools } from "@/lib/pi/eggent-tools";
import type { PiSessionOptions } from "@/lib/pi/types";
import { getChatFiles } from "@/lib/storage/chat-files-store";
import type { ChatFile, ProjectSkillMetadata } from "@/lib/types";
import {
  ensureProjectMcpAdapterConfig,
  getProject,
  getWorkDir,
  loadProjectModelSettings,
  loadProjectSkillsMetadata,
} from "@/lib/storage/project-store";
import { getEggentAiModelLockState, getPiModelRegistry, getPiModelRuntime, getPiSettingsManager } from "@/lib/pi/config-store";

const EGGENT_CONTEXT_FILE_CANDIDATES = [
  "AGENTS.md",
  "AGENTS.MD",
  "agents.md",
  "Agents.md",
  "CLAUDE.md",
  "CLAUDE.MD",
  "claude.md",
  "Claude.md",
];

function normalizeProjectId(projectId?: string | null): string | undefined {
  const trimmed = projectId?.trim();
  return trimmed && trimmed !== "none" ? trimmed : undefined;
}

function resolveCwd(options: PiSessionOptions): string {
  const rawCwd = options.cwd?.trim();
  if (rawCwd && path.isAbsolute(rawCwd)) return rawCwd;

  const projectId = normalizeProjectId(options.projectId);
  const root = projectId ? getWorkDir(projectId) : getWorkDir(null);
  return rawCwd ? path.join(root, rawCwd) : root;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
  for (const filename of EGGENT_CONTEXT_FILE_CANDIDATES) {
    const filePath = path.join(dir, filename);
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      return { path: filePath, content: fs.readFileSync(filePath, "utf-8") };
    } catch {
      // Ignore unreadable context files; Pi's resource loader does the same.
    }
  }
  return null;
}

function loadEggentContextFiles(cwd: string, agentDir: string): Array<{ path: string; content: string }> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  const add = (file: { path: string; content: string } | null) => {
    if (!file) return;
    const resolved = path.resolve(file.path);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    contextFiles.push({ ...file, path: resolved });
  };

  add(loadContextFileFromDir(agentDir));

  const ancestors: Array<{ path: string; content: string }> = [];
  const seenAncestors = new Set<string>();
  let currentDir = path.resolve(cwd);
  while (true) {
    const file = loadContextFileFromDir(currentDir);
    if (file) {
      const resolved = path.resolve(file.path);
      if (!seenAncestors.has(resolved)) {
        seenAncestors.add(resolved);
        ancestors.unshift({ ...file, path: resolved });
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  for (const file of ancestors) add(file);
  return contextFiles;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatChatFilesContext(chatFiles: ChatFile[]): string[] {
  if (chatFiles.length === 0) return [];
  const rows = chatFiles
    .map((file) => `| ${file.name} | ${file.type} | ${file.path} | ${formatFileSize(file.size)} |`)
    .join("\n");
  return [
    "",
    "Chat uploaded files:",
    "These files are attached to the current chat and are available on disk. Use the built-in read tool with the absolute Path shown below, or pass that path to other file-capable tools. Image files are visual context attachments; read them directly by absolute path when the user asks about pasted/uploaded screenshots or pictures. Do not say you cannot see uploaded files before checking this list.",
    "| File | Type | Path | Size |",
    "| --- | --- | --- | --- |",
    rows,
  ];
}

function formatProjectSkillsContext(options: { projectId?: string; cwd: string; skills: ProjectSkillMetadata[] }): string[] {
  if (!options.projectId || options.skills.length === 0) return [];
  const rows = options.skills
    .map((skill) => {
      const skillFile = path.join(skill.skillDir, "SKILL.md");
      const relative = path.relative(options.cwd, skillFile).replace(/\\/g, "/");
      const cwdRelative = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? `./${relative}`
        : skillFile;
      return `| ${skill.name} | ${cwdRelative} | ${skillFile} | ${skill.description} |`;
    })
    .join("\n");
  return [
    "",
    "Project-local Pi skills:",
    "These Eggent project skills are passed to Pi as project-scoped skills for this session. When the user asks to use one, read its SKILL.md from the exact path below before acting. The session cwd is already the project root, so do not prefix paths with data/projects/<projectId>; use the cwd-relative path (for example ./skills/name/SKILL.md) or the absolute path exactly as shown.",
    "| Skill | CWD-relative SKILL.md | Absolute SKILL.md | Description |",
    "| --- | --- | --- | --- |",
    rows,
  ];
}

function buildEggentProjectContext(options: {
  projectId?: string;
  projectName?: string;
  projectDescription?: string;
  projectInstructions?: string;
  memorySubdir: string;
  cwd: string;
  chatFiles?: ChatFile[];
  projectSkills?: ProjectSkillMetadata[];
  runtimeModel?: {
    provider?: string;
    id?: string;
    name?: string;
  };
}): string {
  return [
    "# Eggent runtime context",
    "",
    options.projectId
      ? "Mode: Project agent"
      : "Mode: Orchestrator",
    options.projectId
      ? "This Eggent project is the configuration for the current pi agent."
      : "This orchestrator coordinates all Eggent projects. Each first-level subdirectory in the working directory is a project.",
    "Eggent is a universal AI assistant and automation workspace, not just a coding assistant.",
    "Do not introduce yourself as a coding assistant unless the user specifically asks for coding work. Code, files, and commands are capabilities, not Eggent's identity.",
    "Eggent configures the runtime; the runtime owns reasoning, tools, skills, sessions, compaction, extensions, and tool execution.",
    "",
    options.projectId ? `Project id: ${options.projectId}` : "Project id: orchestrator",
    options.projectName ? `Project name: ${options.projectName}` : "",
    options.projectDescription ? `Project description: ${options.projectDescription}` : "",
    `Working directory: ${options.cwd}`,
    `Memory file: memory.md`,
    options.runtimeModel?.provider && options.runtimeModel?.id
      ? `Current runtime model: ${options.runtimeModel.provider}/${options.runtimeModel.id}${options.runtimeModel.name ? ` (${options.runtimeModel.name})` : ""}`
      : "Current runtime model: not selected",
    "If the user asks which model/provider is being used, answer from the Current runtime model line above rather than from model self-identification.",
    "",
    "Project instructions:",
    options.projectInstructions?.trim() || "No project-specific instructions configured.",
    ...formatProjectSkillsContext({ projectId: options.projectId, cwd: options.cwd, skills: options.projectSkills ?? [] }),
    ...formatChatFilesContext(options.chatFiles ?? []),
    "",
    "Available Eggent bridge tools:",
    "- list_projects / create_project / switch_project for navigating Eggent projects.",
    options.projectId
      ? "- eggent_memory_search / eggent_memory_save / eggent_memory_delete for the project memory.md file."
      : "- Project memory tools require a selected project or explicit project_id.",
    options.projectId
      ? "- Use pi-mcp-adapter's mcp proxy tool for MCP servers configured in this project's .mcp.json."
      : "- Project MCP tools are available through pi-mcp-adapter after switching into a project.",
    "- Use pi-web-access tools (web_search, fetch_content, get_search_content) for internet access when available.",
    "- eggent_manage_schedules for listing or clearing pi-subagents scheduled tasks. Do not use Agent.schedule to manage existing schedules.",
    options.projectSkills?.length
      ? "- Project-local skills are listed above and are available as Pi skills in this project scope. Prefer those exact skill paths when activating a project skill."
      : "- No project-local skills are installed for this project.",
    options.chatFiles?.length
      ? "- Uploaded chat files are listed above. Read them by absolute path when the user asks about attached/uploaded files."
      : "- No uploaded chat files are currently attached to this chat.",
    "- eggent_list_pipelines / eggent_start_pipeline for existing configured pipelines.",
    "- eggent_start_project_sequence for ad-hoc requests that name project ids in order, such as 'first in project A, then in project B'.",
  ]
    .filter(Boolean)
    .join("\n");
}

function getEggentPiSessionDir(): string {
  return path.join(process.cwd(), "data", "pi-sessions");
}

function createSessionManager(options: PiSessionOptions, cwd: string): SessionManager {
  if (!options.chatId) {
    return SessionManager.inMemory(cwd);
  }

  const sessionDir = getEggentPiSessionDir();
  fs.mkdirSync(sessionDir, { recursive: true });
  const safeChatId = options.chatId.replace(/[^A-Za-z0-9._-]/g, "-");
  const existingSessions = fs
    .readdirSync(sessionDir)
    .filter((file) => file.endsWith(`_${safeChatId}.jsonl`))
    .sort();
  const existing = existingSessions[existingSessions.length - 1];

  if (existing) {
    return SessionManager.open(path.join(sessionDir, existing), sessionDir, cwd);
  }

  return SessionManager.create(cwd, sessionDir, { id: safeChatId });
}

/**
 * Creates a pi SDK AgentSession for Eggent.
 *
 * This is intentionally thin: pi owns model resolution, tools, skills,
 * extensions, context files, retry/compaction, and session behavior.
 */
export async function createEggentPiSession(options: PiSessionOptions = {}) {
  const projectId = normalizeProjectId(options.projectId);
  const cwd = resolveCwd({ ...options, projectId });
  const agentDir = options.agentDir || getAgentDir();
  const modelRuntime = await getPiModelRuntime();
  const modelRegistry = await getPiModelRegistry(modelRuntime);
  const settingsManager = getPiSettingsManager(cwd);
  await modelRegistry.refresh();
  const projectModelSettings = projectId ? await loadProjectModelSettings(projectId) : null;
  const availableModels = modelRegistry.getAvailable();
  const findAvailableModel = (provider?: string, modelId?: string) => {
    if (!provider || !modelId) return undefined;
    return availableModels.find((model) => model.provider === provider && model.id === modelId);
  };
  const projectConfiguredModel = projectModelSettings && projectModelSettings.inheritsGlobal !== true
    ? findAvailableModel(
        typeof projectModelSettings.provider === "string" ? projectModelSettings.provider : undefined,
        typeof projectModelSettings.model === "string" ? projectModelSettings.model : undefined
      )
    : undefined;
  const globalConfiguredModel = findAvailableModel(settingsManager.getDefaultProvider(), settingsManager.getDefaultModel());
  const configuredModel = projectConfiguredModel || globalConfiguredModel || availableModels[0];
  const modelLock = await getEggentAiModelLockState(cwd);
  const project = projectId ? await getProject(projectId) : null;
  if (projectId) {
    await ensureProjectMcpAdapterConfig(projectId, cwd);
  }
  const memorySubdir =
    options.memorySubdir ||
    (project?.memoryMode === "global" ? "main" : projectId || "main");

  const projectSkills = projectId ? await loadProjectSkillsMetadata(projectId) : [];
  const projectSkillPaths = projectSkills.map((skill) => path.join(skill.skillDir, "SKILL.md"));
  const chatFiles = options.chatId ? await getChatFiles(options.chatId) : [];
  const corePiToolsOnly = options.corePiToolsOnly === true;

  const projectContext = buildEggentProjectContext({
    projectId,
    projectName: project?.name,
    projectDescription: project?.description,
    projectInstructions: project?.instructions,
    memorySubdir,
    cwd,
    chatFiles,
    projectSkills,
    runtimeModel: configuredModel
      ? modelLock.locked
        ? {
            id: modelLock.label,
            name: modelLock.label,
          }
        : {
            provider: configuredModel.provider,
            id: configuredModel.id,
            name: configuredModel.name,
          }
      : undefined,
  });
  const explicitContextFiles = loadEggentContextFiles(cwd, agentDir);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: projectSkillPaths,
    noExtensions: corePiToolsOnly,
    noSkills: corePiToolsOnly,
    noPromptTemplates: corePiToolsOnly,
    noThemes: corePiToolsOnly,
    agentsFilesOverride: (current) => {
      const seen = new Set<string>();
      const agentsFiles = [
        ...current.agentsFiles,
        ...explicitContextFiles,
        {
          path: projectId
            ? path.join(getWorkDir(projectId), "context.md")
            : path.join(getWorkDir(null), "ORCHESTRATOR.md"),
          content: projectContext,
        },
      ].filter((file) => {
        const resolved = path.resolve(file.path);
        if (seen.has(resolved)) return false;
        seen.add(resolved);
        return true;
      });
      return { agentsFiles };
    },
  });
  await resourceLoader.reload();

  const eggentTools = options.enableEggentTools === false
    ? { tools: [], cleanup: async () => {} }
    : await createEggentPiTools({
        chatId: options.chatId,
        projectId,
        cwd,
        memorySubdir,

      });
  const customTools = eggentTools.tools;
  const customToolNames = customTools.map((tool) => tool.name);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: configuredModel,
    modelRuntime,
    resourceLoader,
    tools: options.tools ? [...options.tools, ...customToolNames] : undefined,
    customTools,
    sessionManager: createSessionManager(options, cwd),
  });

  // SDK sessions do not emit extension lifecycle events until bindExtensions()
  // is called. Eggent has no TUI, but extensions such as pi-mcp-adapter and
  // pi-subagents initialize their per-session managers on session_start.
  await session.bindExtensions({ mode: "rpc" });

  const baseDispose = session.dispose.bind(session);
  session.dispose = () => {
    void eggentTools.cleanup().catch((error) => {
      console.error("Failed to clean up Eggent/pi tools:", error);
    });
    baseDispose();
  };

  return session;
}
