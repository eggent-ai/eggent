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
import {
  getProject,
  getWorkDir,
  loadProjectModelSettings,
  loadProjectSkillsMetadata,
} from "@/lib/storage/project-store";
import { getPiAuthStorage, getPiModelRegistry, getPiSettingsManager } from "@/lib/pi/config-store";

function resolveCwd(options: PiSessionOptions): string {
  const rawCwd = options.cwd?.trim();
  if (rawCwd && path.isAbsolute(rawCwd)) return rawCwd;

  if (options.projectId) {
    const projectRoot = getWorkDir(options.projectId);
    return rawCwd ? path.join(projectRoot, rawCwd) : projectRoot;
  }

  return rawCwd || process.cwd();
}

function buildEggentProjectContext(options: {
  projectId?: string;
  projectName?: string;
  projectDescription?: string;
  projectInstructions?: string;
  memorySubdir: string;
  cwd: string;
}): string {
  return [
    "# Eggent project context",
    "",
    "This Eggent project is the configuration for the current pi agent.",
    "Eggent configures the pi runtime; pi owns reasoning, tools, skills, sessions, compaction, and tool execution.",
    "",
    options.projectId ? `Project id: ${options.projectId}` : "Project id: global",
    options.projectName ? `Project name: ${options.projectName}` : "",
    options.projectDescription ? `Project description: ${options.projectDescription}` : "",
    `Working directory: ${options.cwd}`,
    `Memory file: memory.md`,
    "",
    "Project instructions:",
    options.projectInstructions?.trim() || "No project-specific instructions configured.",
    "",
    "Available Eggent bridge tools:",
    "- eggent_memory_search / eggent_memory_save / eggent_memory_delete for the project memory.md file.",
    "- eggent_mcp_* tools for MCP servers configured on this Eggent project.",
    "- eggent_list_pipelines / eggent_start_pipeline for multi-project pipelines.",
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
  const cwd = resolveCwd(options);
  const agentDir = options.agentDir || getAgentDir();
  const authStorage = getPiAuthStorage();
  const modelRegistry = getPiModelRegistry(authStorage);
  const settingsManager = getPiSettingsManager(cwd);
  await authStorage.reload();
  await modelRegistry.refresh();
  const projectModelSettings = options.projectId ? await loadProjectModelSettings(options.projectId) : null;
  const configuredModel = projectModelSettings && projectModelSettings.inheritsGlobal !== true
    ? modelRegistry.find(
        typeof projectModelSettings.provider === "string" ? projectModelSettings.provider : "",
        typeof projectModelSettings.model === "string" ? projectModelSettings.model : ""
      )
    : modelRegistry.find(settingsManager.getDefaultProvider(), settingsManager.getDefaultModel());
  const project = options.projectId ? await getProject(options.projectId) : null;
  const memorySubdir =
    options.memorySubdir ||
    (project?.memoryMode === "global" ? "main" : options.projectId || "main");

  const projectSkillPaths = options.projectId
    ? (await loadProjectSkillsMetadata(options.projectId)).map((skill) =>
        path.join(skill.skillDir, "SKILL.md")
      )
    : [];

  const projectContext = buildEggentProjectContext({
    projectId: options.projectId,
    projectName: project?.name,
    projectDescription: project?.description,
    projectInstructions: project?.instructions,
    memorySubdir,
    cwd,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: projectSkillPaths,
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        {
          path: options.projectId
            ? path.join(getWorkDir(options.projectId), "context.md")
            : path.join(process.cwd(), "EGGENT_GLOBAL_CONTEXT.md"),
          content: projectContext,
        },
      ],
    }),
  });
  await resourceLoader.reload();

  const eggentTools = options.enableEggentTools === false
    ? { tools: [], cleanup: async () => {} }
    : await createEggentPiTools({
        chatId: options.chatId,
        projectId: options.projectId,
        cwd,
        memorySubdir,

      });
  const customTools = eggentTools.tools;
  const customToolNames = customTools.map((tool) => tool.name);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: configuredModel,
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: options.tools ? [...options.tools, ...customToolNames] : undefined,
    customTools,
    sessionManager: createSessionManager(options, cwd),
  });

  const baseDispose = session.dispose.bind(session);
  session.dispose = () => {
    void eggentTools.cleanup().catch((error) => {
      console.error("Failed to clean up Eggent/pi tools:", error);
    });
    baseDispose();
  };

  return session;
}
