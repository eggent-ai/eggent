import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "fs/promises";
import path from "path";
import type { McpServerConfig } from "@/lib/types";
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

function resolveOutgoingTelegramFilePath(options: { cwd?: string }, rawPath: string): string {
  const value = rawPath.trim();
  if (!value) throw new Error("file_path is required");
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(options.cwd || process.cwd(), value);
}

export async function createEggentPiTools(options: {
  chatId?: string;
  projectId?: string;
  cwd?: string;
  memorySubdir?: string;
  toolRuntimeData?: Record<string, unknown>;
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
        return textResult(JSON.stringify(result, null, 2), { projectId });
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
        return textResult(JSON.stringify(result, null, 2), { projectId });
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
