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
import { createEggentPiExtensionUIContext } from "@/lib/pi/interaction-ui-context";
import { createEggentInteractiveBashTool } from "@/lib/pi/interactive-bash-tool";
import { normalizePiScheduleStore } from "@/lib/pi/schedule-host";
import { eggentSchedulePolicyExtension } from "@/lib/pi/schedule-policy";
import type { PiSessionOptions } from "@/lib/pi/types";
import { getChatFiles } from "@/lib/storage/chat-files-store";
import type { ChatFile, ProjectSkillMetadata } from "@/lib/types";
import {
  ensureOrchestratorDiskLayout,
  ensureProjectMcpAdapterConfig,
  GLOBAL_PROJECT_ID,
  getProject,
  getProjectMemoryPath,
  getWorkDir,
  loadProjectModelSettings,
  loadProjectSkillsMetadata,
  readProjectContext,
} from "@/lib/storage/project-store";
import { deploymentContext, ensureWebSearchWorkflow, fallbackRuntimeModel, getEggentAiModelLockState, getManagedProviderId, getPiModelRegistry, getPiModelRuntime, getPiSettingsManager } from "@/lib/pi/config-store";
import { getUsageSnapshot, isUsageProviderConfigured } from "@/lib/usage/usage-provider";

/**
 * How much of the included balance is spent, as a level.
 *
 * Read from the snapshot the sidebar already polls, so this costs nothing on a
 * warm cache and degrades to "say nothing" when no provider is configured or
 * the provider is unreachable. A meter the provider marked agentOnly still
 * counts: a workspace on its own model is not spending this balance, and the
 * provider hides the meter for exactly that reason.
 */
async function currentBudgetLevel(): Promise<"ok" | "half" | "low"> {
  try {
    if (!isUsageProviderConfigured()) return "ok";
    const snapshot = await getUsageSnapshot();
    const meter = snapshot?.meters?.find((item) => item.id === "ai" && item.visibility !== "agentOnly");
    if (!meter || !(meter.limit > 0)) return "ok";
    const ratio = meter.used / meter.limit;
    if (ratio >= 0.75) return "low";
    if (ratio >= 0.5) return "half";
    return "ok";
  } catch {
    return "ok";
  }
}
import { getServerTranslator } from "@/i18n/server";

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
  if (options.skills.length === 0) return [];
  const scope = options.projectId ? "project" : "orchestrator";
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
    `Workspace-local Pi skills (${scope} scope):`,
    "These Eggent skills are passed to Pi as workspace-scoped skills for this session. When the user asks to use one, read its SKILL.md from the exact path below before acting. The session cwd is already the workspace root, so do not prefix paths with data/projects/<projectId>; use the cwd-relative path (for example ./skills/name/SKILL.md) or the absolute path exactly as shown.",
    "| Skill | CWD-relative SKILL.md | Absolute SKILL.md | Description |",
    "| --- | --- | --- | --- |",
    rows,
  ];
}

function loadConfiguredMcpServerIds(cwd: string): string[] {
  const filePath = path.join(cwd, ".mcp.json");
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { mcpServers?: unknown };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) return [];
    return Object.keys(parsed.mcpServers).sort();
  } catch {
    return [];
  }
}

function buildEggentProjectContext(options: {
  projectId?: string;
  projectName?: string;
  projectDescription?: string;
  projectInstructions?: string;
  memoryFilePath: string;
  cwd: string;
  chatFiles?: ChatFile[];
  projectSkills?: ProjectSkillMetadata[];
  mcpServerIds?: string[];
  runtimeModel?: {
    provider?: string;
    id?: string;
    name?: string;
  };
  managedModelEnforced?: boolean;
  selfHostedUrl?: string;
  usageToolAvailable?: boolean;
  deploymentContext?: string;
  /**
   * How much of the included balance is gone, as a level rather than a figure.
   * See the note where it is rendered: a live number here would invalidate the
   * prompt cache on every turn.
   */
  budgetLevel?: "ok" | "half" | "low";
}): string {
  // Ordering here is load-bearing, not cosmetic.
  //
  // Providers cache a prompt by its exact prefix and bill cached tokens at a
  // tenth of the price, so everything after the first workspace-specific
  // character is re-billed in full on every call. Guidance that reads the same
  // in every workspace therefore comes first, and anything naming this
  // particular workspace - its project, its model, its deployment block - is
  // pushed to the end. Moving one line of workspace-specific text upwards makes
  // every line below it uncacheable.
  const shared: string[] = [
    "# Eggent runtime context",
    "",
    options.projectId
      ? "Mode: Project agent"
      : "Mode: Orchestrator",
    options.projectId
      ? "This Eggent project is the configuration for the current pi agent."
      : "This orchestrator coordinates all Eggent projects. Each first-level subdirectory of the working directory is a project; the orchestrator's own context.md, memory.md, skills/ and .mcp.json sit next to them in that directory and belong to it, not to any project.",
    "Eggent is a universal AI assistant and automation workspace, not just a coding assistant.",
    "Do not introduce yourself as a coding assistant unless the user specifically asks for coding work. Code, files, and commands are capabilities, not Eggent's identity.",
    "Eggent configures the runtime; the runtime owns reasoning, tools, skills, sessions, compaction, extensions, and tool execution.",
    "",
    // "What are you?" is the single most common opening message, and vague
    // answers to it lose users in the first minute. Give one concrete shape to
    // describe instead of letting each run improvise.
    "Answering \"who/what are you\", \"what can you do\", and comparison questions:",
    "- Describe Eggent as a workspace where the assistant does things, not only answers: projects that each keep their own memory, instructions, skills and MCP servers; files; scheduled jobs; pipelines; sub-agents; and Telegram as a second interface to the same workspace. Eggent is open source.",
    "- Keep it to a few lines and end by asking what the user actually wants to do. Offer concrete openers that match this product: send a document to analyse, point at a site or channel, or describe a work process to automate.",
    "- For comparisons with other assistants or agents (Claude Code, Codex, Hermes, a plain chat subscription): name two or three real differences, do not disparage the other tool, and say plainly what Eggent is worse at. Then ask which task they are choosing for, because a comparison without a task is meaningless.",
    "- When the user already runs another agent, the useful answer is how to interoperate with it, not why to replace it: an MCP server on either side, shared skill files, exchanged files, or Eggent's external API. Lead with that.",
    "",
    "If the user asks which model/provider is being used, answer from the Current runtime model line below rather than from model self-identification.",
    options.managedModelEnforced
      ? [
          "This workspace runs on the managed Eggent model, and the model/provider cannot be changed from inside it.",
          "If the user wants to use their own model, provider, API key, OAuth login, or a local model such as Ollama:",
          `- Tell them plainly that switching models is not available in this workspace, and that Eggent is open source and can be self-hosted with any provider: ${options.selfHostedUrl}`,
          "- Do not walk them through connecting another provider here, do not edit settings.json / models.json / auth.json, and do not suggest workarounds for the restriction.",
          "- Helping them set up a self-hosted Eggent (install steps, Docker, server sizing) is fine and encouraged.",
        ].join("\n")
      : "",
    "",
    "Available Eggent bridge tools:",
    "- eggent_ask_user to ask the user a question as a card with buttons instead of plain text. Use it for setup choices and confirmations, especially inside skills: a questionnaire typed into chat loses people who do not know the answers, while buttons do not. Ask one question at a time and always include an option that lets the user hand the decision back to you.",
    "- eggent_manage_telegram to connect, check or disconnect this workspace's Telegram bot, and to grant access to it. When a user supplies a BotFather token, this is the only way to actually connect it; calling the Telegram API by hand sends a message without ever wiring up delivery.",
    "- A newly connected bot answers the first message with \"activate access with a code\", because nobody is allowed to talk to it yet. Finish that yourself: eggent_manage_telegram with action=allow_user grants the account this conversation is already with, and action=access_code hands over a code the user sends to their own bot as `/code <code>`. Do not send them to the settings screen to hunt for it - that is where people give up.",
    "- eggent_manage_models to see the current model setup and to connect a provider that is not in the built-in list. Any OpenAI-compatible endpoint - a hosted API, a router, a local model server - needs only its base URL and model ids, and this tool writes them into the workspace configuration itself. Never answer that a custom provider has to be added by hand, that files must be edited, or that environment variables must be set: none of that is true here, and telling a user it is loses them.",
    "- An API key should not have to travel through chat, because a chat message is stored and is sent to the model. Prefer registering the provider without a key and telling the user to paste it in Settings, where the provider now appears. If the user pastes a key anyway, pass it to the tool rather than writing it to a file, and do not repeat it back.",
    "",
    "Where things live in the Eggent interface, for when the user asks where to click:",
    "- Settings -> Models and login: provider, sign-in or API key, model choice, image model, and the custom providers editor.",
    "- Settings -> Context / Memory / Skills / MCP: the orchestrator's own files. A project has the same four on its own page under Settings -> Projects.",
    "- Settings -> Messengers: Telegram. Settings -> API: the external API token. Settings -> Schedules and Pipelines: recurring and multi-step work.",
    "- list_projects / create_project / switch_project for navigating Eggent projects.",
    options.projectId
      ? "- eggent_memory_search / eggent_memory_save / eggent_memory_delete for the project memory.md file."
      : "- eggent_memory_search / eggent_memory_save / eggent_memory_delete for the orchestrator's own memory.md file. Pass project_id to reach a specific project's memory instead.",
    options.projectId
      ? "- Use pi-mcp-adapter's mcp proxy tool for MCP servers configured in this project's .mcp.json."
      : "- Use pi-mcp-adapter's mcp proxy tool for MCP servers configured in the orchestrator's own .mcp.json. A project's MCP servers become available after switching into that project.",
    "- MCP OAuth tokens are persisted in the Pi agent data directory and can be reused across chats/sessions for the same MCP server id and URL. When using an already configured MCP server, call `mcp({ connect: \"<server>\" })` first; call `auth-start` only if connect returns `auth_required` or explicitly says re-authentication is required.",
    // Eggent runs headless, so a child process that wants to open a browser can
    // never succeed here. Agents used to spend dozens of turns rediscovering
    // that; state the rule and the two working alternatives up front.
    "- Choosing an MCP transport: interactive OAuth works only over the `http` transport, where Eggent runs the flow itself. If a server documents both an npm/stdio client and an HTTP endpoint, configure the HTTP one whenever the server needs a user login.",
    "- `stdio` MCP servers cannot log a user in: there is no browser in this environment, and the server's own device/federation login will fail. Authenticate them by passing an existing token or service-account key through the `env` field of upsert_mcp_server instead.",
    "- If an MCP server fails with `browser can not be opened`, `federation id authentication`, `Connection closed` immediately after start, or an equivalent, stop retrying at once. Do not install vendor CLIs, inspect binaries, or hunt for client ids. Tell the user the server needs a login that cannot happen in this environment and offer the three real options: the same server over HTTP transport, a token supplied through `env`, or running Eggent self-hosted where a browser is available.",
    "- Use pi-web-access tools (web_search, fetch_content, get_search_content) for internet access when available.",
    "- When installing project skills with the `skills` CLI from a non-interactive web run, pass `-y`/`--yes` (for example `npx skills add owner/repo -y`) to avoid terminal selection prompts that cannot be reliably controlled from chat.",
    "- eggent_manage_schedules for listing, updating, or clearing existing pi-subagents scheduled tasks. Never edit .pi/subagent-schedules files with edit, write, or bash, and do not use Agent.schedule to manage an existing task.",
    "- eggent_generate_image for image generation/editing/restyling requests. Use reference_image_paths from uploaded chat files when the user asks to edit or use an attached picture. Images are configured separately from the text model: the included Eggent AI model covers both, while a workspace on its own provider needs its own image provider and model chosen in Settings. When the tool reports that no image backend is available, say so in one line and offer the two real options - pick an image provider and model in Settings, or switch back to Eggent AI, which turns text and images on together. Never claim an image was produced when it was not.",
    options.usageToolAvailable
      ? "- eggent_usage_status for any question about balance, remaining credits/tokens, quota, limits, plan or trial. Call it and answer with the real numbers; never guess and never tell the user this information is unavailable to you."
      : "",
    "- eggent_list_pipelines / eggent_start_pipeline for existing configured pipelines.",
    "- eggent_start_project_sequence for ad-hoc requests that name project ids in order, such as 'first in project A, then in project B'.",
  ];

  // Everything below names this workspace, so it is where the shared prefix
  // ends. Keep new workspace-specific facts here rather than above.
  const thisWorkspace: string[] = [
    "",
    "## This workspace",
    // The balance warning only ever reached people who opened the web sidebar,
    // or who thought to ask. Someone working over Telegram spent an entire
    // trial across four hours and learned about the limit from the message that
    // stopped them mid-task. The level goes here so the agent can say it once,
    // unprompted, in whatever surface the person is actually using.
    //
    // Deliberately a level and not a figure: this sits in the cached prefix
    // tail, so a line carrying "€1.23 left" would change on every single turn
    // and cost more in cache misses than the warning is worth. It changes at
    // most twice in a workspace's life.
    options.budgetLevel === "half"
      ? "Budget: about half of the included Eggent AI balance is used. Nothing to do yet. Mention it once, in passing, only if it fits what you are already saying."
      : options.budgetLevel === "low"
        ? "Budget: the included Eggent AI balance is running low. Say so once, plainly, at the end of your next reply — before a task stops halfway is the only useful time to hear it. Do not repeat it every turn, and do not let it interrupt the work."
        : "",
    options.projectId ? `Project id: ${options.projectId}` : "Project id: orchestrator",
    options.projectName ? `Project name: ${options.projectName}` : "",
    options.projectDescription ? `Project description: ${options.projectDescription}` : "",
    `Working directory: ${options.cwd}`,
    `Memory file: ${options.memoryFilePath}`,
    // A managed workspace reports a label without a provider id, so require only
    // the id here. Requiring the provider made managed workspaces claim "not
    // selected", which left users believing no model was configured at all.
    options.runtimeModel?.id
      ? `Current runtime model: ${options.runtimeModel.provider ? `${options.runtimeModel.provider}/` : ""}${options.runtimeModel.id}${options.runtimeModel.name && options.runtimeModel.name !== options.runtimeModel.id ? ` (${options.runtimeModel.name})` : ""}`
      : "Current runtime model: not selected",
    options.mcpServerIds?.length
      ? `Configured MCP servers in this workspace: ${options.mcpServerIds.join(", ")}`
      : "Configured MCP servers in this workspace: none",
    options.mcpServerIds?.includes("higgsfield")
      ? "- Higgsfield is configured as an MCP server in this project. For Higgsfield image/video generation in Eggent cloud/web, prefer the `mcp` proxy (`connect`, `search`, `describe`, then tool call) over the `higgsfield` CLI. Do not run `higgsfield auth login`, `higgsfield account status`, or `higgsfield workspace set` unless the user explicitly asks for CLI setup; MCP OAuth is separate from CLI auth and is already persisted after successful authentication."
      : "",
    // Supplied by the operator of this deployment. Eggent does not know what it
    // says, so it is quoted rather than summarized, and it outranks guesswork.
    options.deploymentContext
      ? [
          "",
          "Deployment context (written by the operator of this deployment, authoritative):",
          options.deploymentContext,
          "Answer from the facts in this block whenever the user asks what this service costs, how to pay, what the trial covers, where to get support, or whether a free alternative exists. Never invent terms, prices or contacts that are not written here, and never say you have no information about it while this block exists.",
          "This block is addressed to you, not to the user: it describes them in the third person. Do not paste or quote it. Say only the part that answers the question, in your own words, in the user's language, speaking to them directly.",
        ].join("\n")
      : "",
    "",
    options.projectId ? "Project instructions:" : "Orchestrator instructions:",
    options.projectInstructions?.trim()
      || (options.projectId
        ? "No project-specific instructions configured."
        : "No orchestrator-specific instructions configured."),
    ...formatProjectSkillsContext({ projectId: options.projectId, cwd: options.cwd, skills: options.projectSkills ?? [] }),
    ...formatChatFilesContext(options.chatFiles ?? []),
    options.projectSkills?.length
      ? "- Workspace-local skills are listed above and are available as Pi skills in this scope. Prefer those exact skill paths when activating one."
      : options.projectId
        ? "- No project-local skills are installed for this project."
        : "- No orchestrator skills are installed.",
    options.chatFiles?.length
      ? "- Uploaded chat files are listed above. Read them by absolute path when the user asks about attached/uploaded files."
      : "- No uploaded chat files are currently attached to this chat.",
  ];

  return [...shared, ...thisWorkspace].filter(Boolean).join("\n");
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
  await ensureWebSearchWorkflow();
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
  const modelLock = await getEggentAiModelLockState(cwd);

  // Whenever the workspace is on the managed model, resolve it from the managed
  // credential rather than trusting settings.json / models.json.
  //
  // Under enforcement this is a security property: those files live in the
  // workspace and the agent can edit them with bash, so API-level checks alone
  // would not hold. It matters just as much unenforced: the chat footer reports
  // the lock label while the run resolves settings by exact model id, so one
  // stale or mistyped id sent the run to whichever provider happened to be first
  // in the list while the UI kept saying Eggent AI.
  const managedModel = modelLock.locked
    ? await (async () => {
        const managedProvider = await getManagedProviderId();
        if (!managedProvider) return undefined;
        return availableModels.find((model) => model.provider === managedProvider);
      })()
    : undefined;

  const configuredModel = managedModel
    || projectConfiguredModel
    || globalConfiguredModel
    || (modelLock.locked ? availableModels[0] : await fallbackRuntimeModel(availableModels));
  // A workspace that disconnected the included model and picked nothing else has
  // no model at all. Saying so is the point: it used to fall back to the managed
  // credential and keep answering as if nothing had been disconnected.
  if (!configuredModel) {
    throw new Error((await getServerTranslator())("chat.errors.noModelSelected"));
  }
  const project = projectId ? await getProject(projectId) : null;
  // Project or orchestrator, the scope owns the same four files. Only the
  // directory they are read from differs.
  const scopeId = projectId ?? GLOBAL_PROJECT_ID;
  if (!projectId) {
    await ensureOrchestratorDiskLayout();
  }
  // A project also gets its .mcp.json mirrored into the session cwd, so
  // pi-mcp-adapter finds it when the run starts in a subdirectory. The
  // orchestrator's subdirectories are the projects themselves, and mirroring
  // there would overwrite a project's own config, so its file is only ensured
  // in place.
  await ensureProjectMcpAdapterConfig(scopeId, projectId ? cwd : undefined);
  const memorySubdir =
    options.memorySubdir ||
    (project?.memoryMode === "global" ? "main" : projectId || "main");

  // A project keeps its instructions in project.json (mirrored to context.md);
  // the orchestrator has only the file.
  const workspaceInstructions = project ? project.instructions : await readProjectContext(scopeId);
  const projectSkills = await loadProjectSkillsMetadata(scopeId);
  const projectSkillPaths = projectSkills.map((skill) => path.join(skill.skillDir, "SKILL.md"));
  // Read the scope's own file rather than the session cwd: an orchestrator run
  // started inside a project directory would otherwise report that project's
  // servers as its own.
  const mcpServerIds = loadConfiguredMcpServerIds(getWorkDir(scopeId));
  const chatFiles = options.chatId ? await getChatFiles(options.chatId) : [];
  const corePiToolsOnly = options.corePiToolsOnly === true;

  const projectContext = buildEggentProjectContext({
    projectId,
    projectName: project?.name,
    projectDescription: project?.description,
    projectInstructions: workspaceInstructions,
    memoryFilePath: getProjectMemoryPath(scopeId),
    cwd,
    chatFiles,
    projectSkills,
    mcpServerIds,
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
    managedModelEnforced: modelLock.enforced,
    selfHostedUrl: modelLock.selfHostedUrl,
    usageToolAvailable: isUsageProviderConfigured(),
    deploymentContext: deploymentContext(),
    budgetLevel: await currentBudgetLevel(),
  });
  const explicitContextFiles = loadEggentContextFiles(cwd, agentDir);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [eggentSchedulePolicyExtension],
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

  let sessionDisposed = false;
  let sessionRef: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  let mcpReloadQueued = false;
  const queueMcpRuntimeReload = (details: { projectId: string; serverId: string; action?: string; filePath?: string }) => {
    if (mcpReloadQueued) return;
    mcpReloadQueued = true;
    setTimeout(() => {
      void (async () => {
        const sessionToReload = sessionRef;
        if (sessionDisposed || !sessionToReload) {
          mcpReloadQueued = false;
          return;
        }
        try {
          await sessionToReload.reload();
          console.info("Reloaded Pi runtime after MCP config change", details);
        } catch (error) {
          console.error("Failed to reload Pi runtime after MCP config change", { details, error });
        } finally {
          mcpReloadQueued = false;
        }
      })();
    }, 0);
  };

  const eggentTools = options.enableEggentTools === false
    ? { tools: [], cleanup: async () => {} }
    : await createEggentPiTools({
        chatId: options.chatId,
        projectId,
        scopeId,
        cwd,
        memorySubdir,
        toolRuntimeData: options.toolRuntimeData,
        onMcpConfigChanged: queueMcpRuntimeReload,
        getAgentSession: () => sessionRef,
        runId: options.runId,
        abortSignal: options.abortSignal,
        onPiInteraction: options.onPiInteraction,
        // A UI context is registered for every run, but only a run that streams
        // interactions back has someone able to answer them. Telegram and the
        // external API do not, so asking there would block until timeout.
        interactive: Boolean(options.onPiInteraction),
      });
  const customTools = [
    ...eggentTools.tools,
    ...(options.runId
      ? [createEggentInteractiveBashTool({
          cwd,
          runId: options.runId,
          abortSignal: options.abortSignal,
          commandPrefix: settingsManager.getShellCommandPrefix(),
          shellPath: settingsManager.getShellPath(),
          onInteraction: options.onPiInteraction,
        })]
      : []),
  ];
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
  sessionRef = session;
  // Legacy schedules may predate the execution-only policy. Normalize them
  // before session_start lets pi-subagents read and arm the store.
  await normalizePiScheduleStore(session);

  // SDK sessions do not emit extension lifecycle events until bindExtensions()
  // is called. Eggent has no TUI, but extensions such as pi-mcp-adapter and
  // pi-subagents initialize their per-session managers on session_start. When a
  // run id is present, expose a small RPC-style UI bridge so extensions can
  // pause for user input through Eggent's web chat instead of throwing away the
  // prompt or blocking invisibly.
  await session.bindExtensions({
    mode: "rpc",
    uiContext: options.runId
      ? createEggentPiExtensionUIContext({
          runId: options.runId,
          abortSignal: options.abortSignal,
          onInteraction: options.onPiInteraction,
        })
      : undefined,
  });

  const baseDispose = session.dispose.bind(session);
  session.dispose = () => {
    sessionDisposed = true;
    void eggentTools.cleanup().catch((error) => {
      console.error("Failed to clean up Eggent/pi tools:", error);
    });
    baseDispose();
  };

  return session;
}
