import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "fs/promises";
import path from "path";
import type { McpServerConfig } from "@/lib/types";
import { getPiAuthPath, getPiModelsPath } from "@/lib/pi/config-store";
import { getPipelineDefinitions, upsertPipelineDefinition } from "@/lib/pipelines/store";
import { startPipelineRunInBackground } from "@/lib/pipelines/runner";
import { managePiSchedules } from "@/lib/pi/schedule-host";
import {
  createProject,
  createSkill,
  deleteProjectMcpServer,
  getAllProjects,
  searchProjectMemory,
  appendProjectMemory,
  deleteProjectMemoryMatches,
  upsertProjectMcpServer,
} from "@/lib/storage/project-store";

const TELEGRAM_SEND_FILE_MAX_BYTES = 45 * 1024 * 1024;
const IMAGE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;

interface TelegramRuntimeData {
  botToken: string;
  chatId: string | number;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function getTelegramRuntimeData(toolRuntimeData?: Record<string, unknown>): TelegramRuntimeData | null {
  const raw = toolRuntimeData?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
  const chatIdRaw = record.chatId;
  const chatId = typeof chatIdRaw === "string" || typeof chatIdRaw === "number" ? chatIdRaw : null;
  if (!botToken || chatId === null) return null;
  return { botToken, chatId };
}

function resolveLocalFilePath(options: { cwd?: string }, rawPath: string): string {
  const value = rawPath.trim();
  if (!value) throw new Error("file path is required");
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(options.cwd || process.cwd(), value);
}

function resolveOutgoingTelegramFilePath(options: { cwd?: string }, rawPath: string): string {
  return resolveLocalFilePath(options, rawPath);
}

function imageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) throw new Error(`Unsupported reference image type: ${filePath}`);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Reference image is not a file: ${filePath}`);
  if (stat.size > IMAGE_REFERENCE_MAX_BYTES) {
    throw new Error(`Reference image is too large (${stat.size} bytes). Max allowed is ${IMAGE_REFERENCE_MAX_BYTES} bytes: ${filePath}`);
  }
  const buffer = await fs.readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function resolveManagedImageBackend(): Promise<{ baseUrl: string; token: string; providerLabel: string } | null> {
  try {
    const [auth, models] = await Promise.all([
      readJsonFile(getPiAuthPath()).catch((): Record<string, unknown> => ({})),
      readJsonFile(getPiModelsPath()).catch((): Record<string, unknown> => ({})),
    ]);
    const credential = auth["eggent-ai"];
    const token = credential && typeof credential === "object" && !Array.isArray(credential)
      ? String((credential as Record<string, unknown>).key || "").trim()
      : "";
    const providersValue = models["providers"];
    const providers = providersValue && typeof providersValue === "object" && !Array.isArray(providersValue)
      ? providersValue as Record<string, unknown>
      : {};
    const provider = providers["eggent-ai"];
    const providerRecord = provider && typeof provider === "object" && !Array.isArray(provider)
      ? provider as Record<string, unknown>
      : {};
    const baseUrl = String(providerRecord.baseUrl || "").trim().replace(/\/+$/, "");
    const providerLabel = String(providerRecord.name || "Eggent Images").trim() || "Eggent Images";
    if (!token.startsWith("eggw_") || !baseUrl) return null;
    return { baseUrl, token, providerLabel };
  } catch {
    return null;
  }
}

function imageExtension(mediaType?: string): string {
  const normalized = mediaType?.toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/svg+xml") return "svg";
  return "png";
}

function decodeBase64Image(raw: string): { buffer: Buffer; mediaType?: string } {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(raw);
  if (dataUrl) return { mediaType: dataUrl[1], buffer: Buffer.from(dataUrl[2], "base64") };
  return { buffer: Buffer.from(raw, "base64") };
}

async function writeGeneratedImages(options: { cwd?: string }, payload: unknown): Promise<Array<{ path: string; mediaType?: string; source: string }>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.data) ? record.data : Array.isArray(record.images) ? record.images : [];
  const outputDir = path.join(options.cwd || process.cwd(), "generated-images");
  await fs.mkdir(outputDir, { recursive: true });
  const saved: Array<{ path: string; mediaType?: string; source: string }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const image = item as Record<string, unknown>;
    const b64 = typeof image.b64_json === "string"
      ? image.b64_json
      : typeof image.image === "string"
        ? image.image
        : typeof image.data === "string"
          ? image.data
          : "";
    if (!b64) continue;
    const decoded = decodeBase64Image(b64);
    const mediaType = typeof image.media_type === "string" ? image.media_type : decoded.mediaType;
    const ext = imageExtension(mediaType);
    const filePath = path.join(outputDir, `eggent-image-${new Date().toISOString().replace(/[:.]/g, "-")}-${index + 1}.${ext}`);
    await fs.writeFile(filePath, decoded.buffer);
    saved.push({ path: filePath, mediaType, source: "b64_json" });
  }
  return saved;
}

export async function createEggentPiTools(options: {
  chatId?: string;
  projectId?: string;
  cwd?: string;
  memorySubdir?: string;
  toolRuntimeData?: Record<string, unknown>;
  onMcpConfigChanged?: (details: { projectId: string; serverId: string; action?: string; filePath?: string }) => void;
} = {}): Promise<{ tools: ToolDefinition[]; cleanup: () => Promise<void> }> {
  const memoryProjectId = options.projectId;

  const tools: ToolDefinition[] = [
    defineTool({
      name: "list_projects",
      label: "List Eggent Projects",
      description: "List Eggent projects. Each project is a directory-backed pi agent configuration with context.md, memory.md, skills/, .mcp.json, and model.json. Scheduled tasks are managed by pi-subagents.",
      parameters: Type.Object({}),
      execute: async () => {
        const projects = await getAllProjects();
        return textResult(JSON.stringify(projects, null, 2), { count: projects.length });
      },
    }),
    defineTool({
      name: "create_project",
      label: "Create Eggent Project / Pi Agent Config",
      description: "Create a new Eggent project, which is a pi agent configuration.",
      parameters: Type.Object({
        name: Type.String({ description: "Project/agent name." }),
        description: Type.Optional(Type.String({ description: "Short description." })),
        instructions: Type.Optional(Type.String({ description: "Agent context/instructions injected into pi." })),
        memory_mode: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("isolated")], { description: "Memory namespace mode. Defaults to isolated." })),
      }),
      execute: async (_toolCallId, params) => {
        const id = params.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || crypto.randomUUID().slice(0, 8);
        const project = await createProject({
          id,
          name: params.name,
          description: params.description || "",
          instructions: params.instructions || "",
          memoryMode: params.memory_mode || "isolated",
        });
        return textResult(
          JSON.stringify({ success: true, action: "create_project", projectId: project.id, project }, null, 2),
          { project }
        );
      },
    }),
    defineTool({
      name: "switch_project",
      label: "Switch Eggent Project / Pi Agent Config",
      description: "Switch the Eggent UI to another project/pi agent configuration, or to the orchestrator with project_id='none'.",
      parameters: Type.Object({
        project_id: Type.String({ description: "Project id to switch to. Use 'none' for the orchestrator." }),
        current_path: Type.Optional(Type.String({ description: "Optional relative working directory inside the selected project or orchestrator root." })),
      }),
      execute: async (_toolCallId, params) => {
        return textResult(
          JSON.stringify(
            {
              success: true,
              action: "switch_project",
              projectId: params.project_id,
              currentPath: params.current_path || "",
            },
            null,
            2
          ),
          { projectId: params.project_id }
        );
      },
    }),
    defineTool({
      name: "create_skill",
      label: "Create Eggent Project Skill",
      description: "Create a skill in an Eggent project. The skill is passed to pi when that project runs as an agent.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id. Defaults to current project." })),
        skill_name: Type.String({ description: "Skill name, lowercase/hyphenated." }),
        description: Type.String({ description: "Skill description: what it does and when to use it." }),
        body: Type.String({ description: "SKILL.md body/instructions." }),
      }),
      execute: async (_toolCallId, params) => {
        const projectId = params.project_id || options.projectId;
        if (!projectId) return textResult("No project selected; pass project_id.");
        const result = await createSkill(projectId, {
          skill_name: params.skill_name,
          description: params.description,
          body: params.body,
        });
        return textResult(JSON.stringify(result, null, 2), { projectId });
      },
    }),
    defineTool({
      name: "upsert_mcp_server",
      label: "Upsert Eggent Project MCP Server",
      description: "Create or update an MCP server in an Eggent project's .mcp.json. MCP tools are available through pi-mcp-adapter's mcp proxy tool when the project runs.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id. Defaults to current project." })),
        id: Type.String({ description: "MCP server id." }),
        transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
        command: Type.Optional(Type.String({ description: "STDIO command." })),
        args: Type.Optional(Type.Array(Type.String(), { description: "STDIO args." })),
        env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "STDIO env." })),
        cwd: Type.Optional(Type.String({ description: "STDIO cwd." })),
        url: Type.Optional(Type.String({ description: "HTTP MCP URL." })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "HTTP headers." })),
      }),
      execute: async (_toolCallId, params) => {
        const projectId = params.project_id || options.projectId;
        if (!projectId) return textResult("No project selected; pass project_id.");
        const server = params.transport === "http"
          ? {
              id: params.id,
              transport: "http" as const,
              url: params.url || "",
              headers: params.headers,
            }
          : {
              id: params.id,
              transport: "stdio" as const,
              command: params.command || "",
              args: params.args,
              env: params.env,
              cwd: params.cwd,
            };
        const result = await upsertProjectMcpServer(projectId, server as McpServerConfig);
        options.onMcpConfigChanged?.({
          projectId,
          serverId: params.id,
          action: result.success ? result.action : undefined,
          filePath: result.success ? result.filePath : undefined,
        });
        return textResult(
          JSON.stringify(
            {
              ...result,
              note: "MCP config updated. Eggent is reloading the Pi MCP runtime so the mcp proxy can see the new server in this run.",
            },
            null,
            2
          ),
          { projectId, mcpRuntimeReloadQueued: true }
        );
      },
    }),
    defineTool({
      name: "delete_mcp_server",
      label: "Delete Eggent Project MCP Server",
      description: "Delete an MCP server from an Eggent project/pi agent configuration.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id. Defaults to current project." })),
        server_id: Type.String({ description: "MCP server id to delete." }),
      }),
      execute: async (_toolCallId, params) => {
        const projectId = params.project_id || options.projectId;
        if (!projectId) return textResult("No project selected; pass project_id.");
        const result = await deleteProjectMcpServer(projectId, params.server_id);
        if (result.success) {
          options.onMcpConfigChanged?.({
            projectId,
            serverId: params.server_id,
            action: "deleted",
            filePath: result.filePath,
          });
        }
        return textResult(
          JSON.stringify(
            result.success
              ? {
                  ...result,
                  note: "MCP config updated. Eggent is reloading the Pi MCP runtime so the mcp proxy stops using the deleted server in this run.",
                }
              : result,
            null,
            2
          ),
          { projectId, mcpRuntimeReloadQueued: result.success }
        );
      },
    }),
    defineTool({
      name: "eggent_manage_schedules",
      label: "Manage Pi Scheduled Tasks",
      description: "List or clear pi-subagents scheduled tasks. Use this when the user asks to show, delete, cancel, clear, remove, or убери/удали/отмени запланированные задачи. Do not use Agent.schedule for schedule-management requests.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("clear")], { description: "Use list to show scheduled tasks, clear to remove/cancel scheduled tasks." }),
        scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("all")], { description: "current = current project/session cwd; all = orchestrator and all projects. Defaults to current." })),
      }),
      execute: async (_toolCallId, params) => {
        const result = await managePiSchedules({
          action: params.action,
          scope: params.scope || "current",
          cwd: options.cwd,
        });
        return textResult(JSON.stringify(result, null, 2), result);
      },
    }),
    defineTool({
      name: "eggent_generate_image",
      label: "Generate or Edit Image",
      description: "Generate a new image or edit/create a variant using optional reference images. Use this when the user asks to create, draw, generate, redesign, restyle, edit, improve, replace a background, or make a visual asset. This is separate from the text/agent model: managed Eggent workspaces use Eggent Images, while custom/BYOK workspaces need a configured image backend. For reference-image tasks, pass absolute paths from uploaded chat files or project files in reference_image_paths.",
      parameters: Type.Object({
        prompt: Type.String({ description: "Clear image generation/edit prompt. Include style, subject, constraints, and what should be preserved from references." }),
        reference_image_paths: Type.Optional(Type.Array(Type.String(), { description: "Optional local image file paths to use as references. Use absolute paths when available." })),
        n: Type.Optional(Type.Number({ description: "Number of output images. Defaults to 1." })),
        size: Type.Optional(Type.String({ description: "Optional size/resolution shorthand, e.g. 1K, 2K, 4K, 1024x1024, 2048x2048." })),
        resolution: Type.Optional(Type.String({ description: "Optional resolution tier, e.g. 512, 1K, 2K, 4K." })),
        aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio, e.g. 1:1, 16:9, 9:16, 4:3." })),
        quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Optional quality. Defaults to auto." })),
        output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { description: "Output format. Defaults to png/provider default." })),
        background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")], { description: "Optional background mode." })),
      }),
      execute: async (_toolCallId, params) => {
        const backend = await resolveManagedImageBackend();
        if (!backend) {
          return textResult(
            [
              "Image generation is not configured for this workspace.",
              "Text/chat models and image-generation models are configured separately.",
              "If you are using your own OAuth/API model (for example Codex login), connect an image provider or enable Eggent Images before asking for generated/edited images.",
            ].join("\n"),
            { configured: false, reason: "image_backend_not_configured" }
          );
        }

        const referencePaths = (params.reference_image_paths || []).map((item) => resolveLocalFilePath(options, item));
        const inputReferences: Array<{ type: "image_url"; image_url: { url: string } }> = [];
        for (const referencePath of referencePaths) {
          inputReferences.push({
            type: "image_url",
            image_url: { url: await fileToDataUrl(referencePath) },
          });
        }

        const body: Record<string, unknown> = {
          model: "eggent-ai",
          prompt: params.prompt,
          n: Math.max(1, Math.min(10, Math.trunc(Number(params.n || 1)))) || 1,
        };
        if (params.size) body.size = params.size;
        if (params.resolution) body.resolution = params.resolution;
        if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
        if (params.quality) body.quality = params.quality;
        if (params.output_format) body.output_format = params.output_format;
        if (params.background) body.background = params.background;
        if (inputReferences.length > 0) body.input_references = inputReferences;

        const response = await fetch(`${backend.baseUrl}/images`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${backend.token}`,
            "Content-Type": "application/json",
            "X-Eggent-AI-Request-Type": "image",
          },
          body: JSON.stringify(body),
        });
        const responseText = await response.text();
        let payload: unknown = null;
        try {
          payload = responseText ? JSON.parse(responseText) : null;
        } catch {
          payload = responseText;
        }
        if (!response.ok) {
          const message = payload && typeof payload === "object" && !Array.isArray(payload)
            ? String(((payload as Record<string, unknown>).error as Record<string, unknown> | undefined)?.message || responseText || `Image generation failed with HTTP ${response.status}`)
            : responseText || `Image generation failed with HTTP ${response.status}`;
          return textResult(JSON.stringify({ success: false, error: message, status: response.status }, null, 2), { success: false, status: response.status });
        }

        const savedImages = await writeGeneratedImages(options, payload);
        const result = {
          success: true,
          provider: backend.providerLabel,
          imageCount: savedImages.length,
          images: savedImages,
          referenceImageCount: inputReferences.length,
          note: savedImages.length > 0
            ? "Generated image files were saved locally. Show the paths to the user and offer one short next action."
            : "Image provider returned no inline base64 images; inspect rawResponse for URLs or provider-specific output.",
          rawResponse: savedImages.length > 0 ? undefined : payload,
        };
        return textResult(JSON.stringify(result, null, 2), result);
      },
    }),
    defineTool({
      name: "eggent_memory_save",
      label: "Save Eggent Memory",
      description: "Save persistent memory for the current Eggent/pi project agent.",
      parameters: Type.Object({
        text: Type.String({ description: "Memory text to save." }),
        area: Type.Optional(Type.String({ description: "Memory area/category. Defaults to main." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No project selected; project memory is stored in the project's memory.md file.");
        await appendProjectMemory(memoryProjectId, params.text, params.area || "main");
        return textResult("Saved to project memory.md.", { projectId: memoryProjectId, area: params.area || "main" });
      },
    }),
    defineTool({
      name: "eggent_memory_search",
      label: "Search Eggent Memory",
      description: "Search the current project's memory.md file.",
      parameters: Type.Object({
        query: Type.String({ description: "Memory search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of memories. Defaults to 5." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No project selected; project memory is stored in the project's memory.md file.");
        const output = await searchProjectMemory(memoryProjectId, params.query, params.limit || 5);
        return textResult(output, { projectId: memoryProjectId });
      },
    }),
    defineTool({
      name: "eggent_memory_delete",
      label: "Delete Eggent Memory",
      description: "Delete memory.md blocks matching a query for the current pi project agent.",
      parameters: Type.Object({
        query: Type.String({ description: "Query for memory.md blocks to delete." }),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No project selected; project memory is stored in the project's memory.md file.");
        const output = await deleteProjectMemoryMatches(memoryProjectId, params.query);
        return textResult(output, { projectId: memoryProjectId });
      },
    }),
    defineTool({
      name: "eggent_list_pipelines",
      label: "List Eggent Pipelines",
      description:
        "List configured Eggent pipelines. In the new architecture a pipeline is a sequence of Eggent projects/pi agents.",
      parameters: Type.Object({}),
      execute: async () => {
        const pipelines = await getPipelineDefinitions();
        return textResult(
          JSON.stringify(
            pipelines.map((pipeline) => ({
              id: pipeline.id,
              name: pipeline.name,
              description: pipeline.description,
              steps: pipeline.steps.map((step) => ({
                id: step.id,
                name: step.name,
                projectId: step.projectId,
                instructions: step.instructions,
              })),
            })),
            null,
            2
          ),
          { count: pipelines.length }
        );
      },
    }),
    defineTool({
      name: "eggent_start_pipeline",
      label: "Start Eggent Pipeline",
      description:
        "Start an existing configured Eggent pipeline by pipeline id/name. Do not pass project ids here. For ad-hoc user requests like 'first run project A, then project B', use eggent_start_project_sequence instead.",
      parameters: Type.Object({
        pipelineId: Type.String({ description: "Existing pipeline id or name to start. This is not a project id." }),
        input: Type.String({ description: "User task/input to pass to the pipeline." }),
      }),
      execute: async (_toolCallId, params) => {
        const run = await startPipelineRunInBackground({
          pipelineId: params.pipelineId,
          input: params.input,
          chatId: options.chatId,
          projectId: options.projectId,
          cwd: options.cwd,
        });
        return textResult(
          JSON.stringify(
            {
              runId: run.id,
              status: run.status,
              pipelineId: run.pipelineId,
              artifactsDir: run.artifactsDir,
              steps: run.steps.map((step) => ({
                id: step.stepId,
                name: step.name,
                projectId: step.projectId,
                status: step.status,
              })),
            },
            null,
            2
          ),
          { run }
        );
      },
    }),
    defineTool({
      name: "eggent_start_project_sequence",
      label: "Start Ad-hoc Project Sequence",
      description:
        "Create and start a one-off Eggent pipeline from an ordered list of project steps. Use this when the user says to run a pipeline/sequence across project ids, e.g. 'first in project 222 do X, then in project 123 do Y'.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "Optional name for this one-off pipeline run." })),
        input: Type.String({ description: "Overall user request/input for the sequence." }),
        steps: Type.Array(
          Type.Object({
            project_id: Type.String({ description: "Eggent project id for this step." }),
            name: Type.Optional(Type.String({ description: "Human-readable step name." })),
            instructions: Type.String({ description: "What this project should do in this step." }),
          }),
          { minItems: 1, description: "Ordered project-agent steps." }
        ),
      }),
      execute: async (_toolCallId, params) => {
        const id = `adhoc-${crypto.randomUUID()}`;
        const pipeline = await upsertPipelineDefinition({
          id,
          name: params.name || "Ad-hoc project sequence",
          description: "One-off pipeline created from a chat request.",
          steps: params.steps.map((step, index) => ({
            id: `step-${index + 1}`,
            name: step.name || `Step ${index + 1}: ${step.project_id}`,
            projectId: step.project_id,
            instructions: step.instructions,
          })),
        });
        const run = await startPipelineRunInBackground({
          pipelineId: pipeline.id,
          input: params.input,
          chatId: options.chatId,
          projectId: options.projectId,
          cwd: options.cwd,
        });
        return textResult(
          JSON.stringify(
            {
              runId: run.id,
              status: run.status,
              pipelineId: run.pipelineId,
              pipelineName: pipeline.name,
              artifactsDir: run.artifactsDir,
              steps: run.steps.map((step) => ({
                id: step.stepId,
                name: step.name,
                projectId: step.projectId,
                status: step.status,
              })),
            },
            null,
            2
          ),
          { run, pipeline }
        );
      },
    }),
  ];

  const telegramRuntime = getTelegramRuntimeData(options.toolRuntimeData);
  if (telegramRuntime) {
    tools.push(defineTool({
      name: "telegram_send_file",
      label: "Send File to Telegram",
      description: "Send a local file to the current Telegram chat as a document. Use this when the user asks to send, return, export, download, or share a file in Telegram.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Absolute path to the file, or path relative to the current project cwd." }),
        caption: Type.Optional(Type.String({ description: "Optional caption to include with the file." })),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const resolvedPath = resolveOutgoingTelegramFilePath(options, params.file_path);
          const stat = await fs.stat(resolvedPath);
          if (!stat.isFile()) {
            return textResult(JSON.stringify({ success: false, error: `Path is not a file: ${resolvedPath}` }, null, 2));
          }
          if (stat.size > TELEGRAM_SEND_FILE_MAX_BYTES) {
            return textResult(JSON.stringify({ success: false, error: `File is too large (${stat.size} bytes). Max allowed is ${TELEGRAM_SEND_FILE_MAX_BYTES} bytes.` }, null, 2));
          }

          const fileBuffer = await fs.readFile(resolvedPath);
          const form = new FormData();
          form.append("chat_id", String(telegramRuntime.chatId));
          form.append("document", new Blob([fileBuffer]), path.basename(resolvedPath));
          const trimmedCaption = params.caption?.trim();
          if (trimmedCaption) form.append("caption", trimmedCaption);

          const response = await fetch(`https://api.telegram.org/bot${telegramRuntime.botToken}/sendDocument`, {
            method: "POST",
            body: form,
          });
          const payload = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: { document?: { file_id?: string; file_name?: string; file_size?: number } } } | null;
          if (!response.ok || !payload?.ok) {
            return textResult(JSON.stringify({ success: false, error: `Telegram sendDocument failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}` }, null, 2));
          }

          return textResult(JSON.stringify({
            success: true,
            message: "File sent to Telegram successfully.",
            path: resolvedPath,
            name: payload.result?.document?.file_name || path.basename(resolvedPath),
            size: payload.result?.document?.file_size ?? stat.size,
            telegramFileId: payload.result?.document?.file_id ?? null,
          }, null, 2));
        } catch (error) {
          return textResult(JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Failed to send file to Telegram." }, null, 2));
        }
      },
    }));
  }

  return { tools, cleanup: async () => {} };
}
