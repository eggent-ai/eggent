import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "@/lib/types";
import { getPipelineDefinitions } from "@/lib/pipelines/store";
import { startPipelineRunInBackground } from "@/lib/pipelines/runner";
import {
  callMcpTool,
  closeMcpConnection,
  connectMcpServer,
  listMcpTools,
  type McpConnection,
} from "@/lib/mcp/client";
import {
  createProject,
  createSkill,
  deleteProjectMcpServer,
  getAllProjects,
  loadProjectMcpServers,
  searchProjectMemory,
  appendProjectMemory,
  deleteProjectMemoryMatches,
  upsertProjectMcpServer,
} from "@/lib/storage/project-store";

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
}

function normalizeArgs(params: Record<string, unknown>): Record<string, unknown> {
  const nested = params.arguments;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  const { arguments: _ignored, ...rest } = params;
  return rest;
}

async function createMcpPiTools(projectId?: string): Promise<{
  tools: ToolDefinition[];
  cleanup: () => Promise<void>;
}> {
  if (!projectId) return { tools: [], cleanup: async () => {} };

  const config = await loadProjectMcpServers(projectId);
  if (!config?.servers?.length) return { tools: [], cleanup: async () => {} };

  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  for (const server of config.servers) {
    const conn = await connectMcpServer(server);
    if (!conn) continue;
    connections.push(conn);

    const mcpTools = await listMcpTools(conn.client);
    for (const mcpTool of mcpTools) {
      const toolName = safeToolName(`eggent_mcp_${server.id}_${mcpTool.name}`);
      const schemaHint = mcpTool.inputSchema
        ? ` MCP input schema: ${JSON.stringify(mcpTool.inputSchema)}`
        : "";
      tools.push(
        defineTool({
          name: toolName,
          label: `MCP ${server.id}: ${mcpTool.name}`,
          description:
            `[Eggent project MCP ${server.id}] ${mcpTool.description || mcpTool.name}.` +
            `${schemaHint} Pass arguments as a JSON object in the arguments field.`,
          parameters: Type.Object({
            arguments: Type.Optional(
              Type.Record(Type.String(), Type.Any(), {
                description: "Arguments for the underlying MCP tool.",
              })
            ),
          }),
          execute: async (_toolCallId, params) => {
            const args = normalizeArgs(params as Record<string, unknown>);
            const output = await callMcpTool(conn.client, mcpTool.name, args);
            return textResult(output, {
              projectId,
              serverId: server.id,
              mcpTool: mcpTool.name,
              args,
            });
          },
        })
      );
    }
  }

  return {
    tools,
    cleanup: async () => {
      await Promise.all(connections.map((conn) => closeMcpConnection(conn)));
    },
  };
}

export async function createEggentPiTools(options: {
  chatId?: string;
  projectId?: string;
  cwd?: string;
  memorySubdir?: string;
} = {}): Promise<{ tools: ToolDefinition[]; cleanup: () => Promise<void> }> {
  const memoryProjectId = options.projectId;
  const mcp = await createMcpPiTools(options.projectId);

  const tools: ToolDefinition[] = [
    defineTool({
      name: "list_projects",
      label: "List Eggent Projects",
      description: "List Eggent projects. Each project is a directory-backed pi agent configuration with context.md, memory.md, skills/, mcp.json, cron.json, and model.json.",
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
      description: "Switch the Eggent UI to another project/pi agent configuration.",
      parameters: Type.Object({
        project_id: Type.String({ description: "Project id to switch to." }),
        current_path: Type.Optional(Type.String({ description: "Optional relative working directory inside the project." })),
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
      description: "Create or update an MCP server on an Eggent project. MCP tools are exposed to pi as eggent_mcp_* tools when the project runs.",
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
        "Start a configured Eggent pipeline in the background. Each pipeline step runs an Eggent project as a pi agent config.",
      parameters: Type.Object({
        pipelineId: Type.String({ description: "Pipeline id or name to start." }),
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
    ...mcp.tools,
  ];

  return { tools, cleanup: mcp.cleanup };
}
