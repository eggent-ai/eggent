import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import fs from "fs/promises";
import path from "path";
import type { McpServerConfig } from "@/lib/types";
import {
  getImageGenerationState,
  getPiAuthPath,
  getPiModelsState,
  getPiSettingsState,
  resolveImageBackend,
  switchToModelProvider,
  upsertCustomModelProvider,
} from "@/lib/pi/config-store";
import { getPipelineDefinitions, upsertPipelineDefinition } from "@/lib/pipelines/store";
import { startPipelineRunInBackground } from "@/lib/pipelines/runner";
import { managePiSchedules } from "@/lib/pi/schedule-host";
import { formatUsageMeter, getUsageSnapshot, isUsageProviderConfigured } from "@/lib/usage/usage-provider";
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

interface ImageBackend {
  baseUrl: string;
  token: string;
  providerLabel: string;
  model: string;
  managed: boolean;
}

/**
 * Which backend answers image requests, if any.
 *
 * The included model covers text and images together, so its image backend is
 * used only while it is the model answering - the gateway credential outlives a
 * switch to your own provider, and using it afterwards silently spent included
 * credits for a workspace that had deliberately left. A workspace on its own
 * provider uses whatever image provider and model it selected in settings.
 */
async function resolveImageToolBackend(): Promise<ImageBackend | null> {
  try {
    const resolved = await resolveImageBackend();
    if (!resolved) return null;
    const auth = await readJsonFile(getPiAuthPath()).catch((): Record<string, unknown> => ({}));
    const credential = auth[resolved.providerId];
    const token = credential && typeof credential === "object" && !Array.isArray(credential)
      ? String((credential as Record<string, unknown>).key || "").trim()
      : "";
    if (!token) return null;
    return {
      baseUrl: resolved.baseUrl,
      token,
      providerLabel: resolved.managed ? "Eggent Images" : resolved.providerId,
      model: resolved.model,
      managed: resolved.managed,
    };
  } catch {
    return null;
  }
}

/**
 * Reads an optional charge report the provider attached to a response.
 *
 * Eggent has no price table of its own — it only forwards a figure the provider
 * already formatted, so deployments without billing simply report nothing.
 */
function extractProviderCharge(payload: unknown): { formatted: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const charge = (payload as Record<string, unknown>).eggent_charge;
  if (!charge || typeof charge !== "object" || Array.isArray(charge)) return null;
  const formatted = (charge as Record<string, unknown>).formatted;
  if (typeof formatted !== "string" || !formatted.trim()) return null;
  return { formatted: formatted.trim() };
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
  /** Storage scope of this run: a project id, or "none" for the orchestrator. */
  scopeId?: string;
  cwd?: string;
  memorySubdir?: string;
  toolRuntimeData?: Record<string, unknown>;
  onMcpConfigChanged?: (details: { projectId: string; serverId: string; action?: string; filePath?: string }) => void;
  /** Whether this run can actually deliver a question to a human and get an answer back. */
  interactive?: boolean;
} = {}): Promise<{ tools: ToolDefinition[]; cleanup: () => Promise<void> }> {
  // Memory, skills and MCP belong to whichever workspace is running, and the
  // orchestrator is one of them.
  const workspaceScopeId = options.scopeId ?? options.projectId;
  const memoryProjectId = workspaceScopeId;

  const tools: ToolDefinition[] = [
    defineTool({
      name: "eggent_ask_user",
      label: "Ask The User",
      description:
        "Ask the user one question and wait for the answer, rendered as a card with buttons or an input field instead of plain chat text. Use for setup choices, confirmations before a destructive or expensive step, and any point where a skill or workflow needs a decision. Prefer choice over free_text: a person who cannot answer a typed question can still press a button. Always offer a choice that lets the user defer to you (for example \"choose for me\") so the flow never dead-ends on someone who does not know the answer. Ask one question at a time; do not use this to interview the user through a long questionnaire.",
      parameters: Type.Object({
        question: Type.String({ description: "The question, in the user's language. Keep it to one sentence." }),
        kind: Type.Optional(
          Type.Union([Type.Literal("choice"), Type.Literal("confirm"), Type.Literal("free_text")], {
            description: "choice = pick one of `options` (default when options are given), confirm = yes/no, free_text = typed answer.",
          })
        ),
        options: Type.Optional(
          Type.Array(Type.String(), {
            description: "Answer choices for kind=choice, 2 to 6 of them, each a short label in the user's language.",
          })
        ),
        placeholder: Type.Optional(Type.String({ description: "Hint shown in the input field for kind=free_text." })),
        title: Type.Optional(Type.String({ description: "Short card heading. Defaults to the question." })),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const question = params.question?.trim();
        if (!question) return textResult(JSON.stringify({ success: false, error: "question is required" }, null, 2));

        const choices = (params.options ?? []).map((option) => option.trim()).filter(Boolean).slice(0, 6);
        const kind = params.kind ?? (choices.length >= 2 ? "choice" : "free_text");
        const title = params.title?.trim() || question;

        // Without someone able to answer, the question would hang until it times
        // out, which reads to the user as the agent freezing. Say so instead and
        // let it keep working. `hasUI` is not enough on its own: every run
        // registers a UI context, but Telegram and the external API have no
        // channel to deliver an interaction card on.
        if (options.interactive === false || ctx?.hasUI === false) {
          return textResult(
            JSON.stringify(
              {
                success: false,
                error: "No interactive UI is attached to this run, so the user cannot be prompted.",
                note: "Ask the question as normal chat text, or pick a sensible default and say which default you picked.",
              },
              null,
              2
            )
          );
        }

        try {
          let answer: string | boolean | undefined;
          if (kind === "confirm") {
            answer = await ctx.ui.confirm(title, question);
          } else if (kind === "choice") {
            if (choices.length < 2) {
              return textResult(
                JSON.stringify({ success: false, error: "kind=choice needs at least 2 options" }, null, 2)
              );
            }
            answer = await ctx.ui.select(title, choices);
          } else {
            answer = await ctx.ui.input(title, params.placeholder?.trim() || question);
          }

          if (answer === undefined) {
            return textResult(
              JSON.stringify(
                {
                  success: false,
                  cancelled: true,
                  note: "The user dismissed the question. Do not ask it again; continue with a reasonable default and tell them what you assumed.",
                },
                null,
                2
              )
            );
          }

          return textResult(JSON.stringify({ success: true, kind, answer }, null, 2), { kind });
        } catch (error) {
          return textResult(
            JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : "Could not ask the user.",
                note: "Continue without the answer: pick a sensible default and say which default you picked.",
              },
              null,
              2
            )
          );
        }
      },
    }),
    defineTool({
      name: "eggent_manage_models",
      label: "Manage Eggent Models And Providers",
      description:
        "Inspect this workspace's model setup and connect a provider that is not in the built-in list. Any OpenAI-compatible endpoint works: pass its base URL and model ids and Eggent writes them into the workspace models.json. Use this whenever the user names a provider, an endpoint or a local model server and asks how to connect it - do not tell them it must be done by hand, and do not ask them to edit files or set environment variables. Adding a provider does not change which model answers; that is action=use_provider. Never repeat an API key back to the user or write it into any file yourself.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("status"),
          Type.Literal("add_provider"),
          Type.Literal("use_provider"),
        ], {
          description: "status = current model and configured providers, add_provider = register/replace a custom provider, use_provider = make an already connected provider the default.",
        }),
        provider_id: Type.Optional(Type.String({ description: "Short id, lowercase, e.g. \"wormsoft\" or \"local-llama\"." })),
        base_url: Type.Optional(Type.String({ description: "Endpoint base URL including /v1 when the provider uses it, for add_provider." })),
        models: Type.Optional(Type.Array(Type.String(), { description: "Model ids exactly as the provider names them, for add_provider." })),
        api: Type.Optional(Type.String({ description: "Streaming API. Defaults to openai-completions, which fits almost every OpenAI-compatible endpoint." })),
        api_key: Type.Optional(Type.String({ description: "Provider API key. Optional: when omitted, the provider is registered without a key and the user can paste it in Settings instead of sending it through chat." })),
        model: Type.Optional(Type.String({ description: "Model id to make default, for use_provider." })),
      }),
      execute: async (_toolCallId, params) => {
        try {
          if (params.action === "status") {
            const [settings, models] = await Promise.all([getPiSettingsState(), getPiModelsState()]);
            return textResult(JSON.stringify({ settings, models }, null, 2));
          }

          if (params.action === "add_provider") {
            if (!params.provider_id || !params.base_url || !params.models?.length) {
              return textResult("provider_id, base_url and models are required to add a provider.");
            }
            const result = await upsertCustomModelProvider({
              id: params.provider_id,
              baseUrl: params.base_url,
              models: params.models,
              api: params.api,
              apiKey: params.api_key,
            });
            return textResult(
              JSON.stringify({
                success: true,
                ...result,
                next: result.hasKey
                  ? "The provider is connected. Call use_provider to make it answer, or leave the current model in place."
                  : "The provider is registered without a key. It now appears in Settings under the model picker, where the user pastes the API key - that keeps the key out of the chat. After that, use_provider can select it.",
                settingsHint: "Settings -> Models and login",
              }, null, 2)
            );
          }

          if (!params.provider_id || !params.model) {
            return textResult("provider_id and model are required to switch the default model.");
          }
          const state = await switchToModelProvider(params.provider_id, params.model, options.cwd);
          return textResult(
            JSON.stringify({
              success: true,
              settings: state,
              note: "The change applies from the next message: this run already started on the previous model.",
            }, null, 2)
          );
        } catch (error) {
          return textResult(error instanceof Error ? error.message : "Failed to update the model configuration.");
        }
      },
    }),
    defineTool({
      name: "eggent_manage_telegram",
      label: "Manage Telegram Bot",
      description:
        "Connect, inspect or disconnect the Telegram bot of this workspace. Use this whenever the user gives a bot token from BotFather or asks to hook the workspace up to Telegram. Sending a message with curl does NOT connect a bot: only this tool registers the token so incoming messages reach the workspace. Never repeat the token back to the user or write it into files.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("status"), Type.Literal("connect"), Type.Literal("disconnect")], {
          description: "status = report the current connection, connect = register a bot, disconnect = remove it.",
        }),
        bot_token: Type.Optional(
          Type.String({
            description: "BotFather token, for action=connect. Omit to re-apply the token already stored.",
          })
        ),
        mode: Type.Optional(
          Type.Union([Type.Literal("polling"), Type.Literal("webhook")], {
            description: "Delivery mode. Defaults to polling, which works without a public URL.",
          })
        ),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const { getTelegramIntegrationPublicSettings } = await import("@/lib/storage/telegram-integration-store");
          const { connectTelegramBot, disconnectTelegramBot } = await import("@/lib/telegram/setup");
          const { getServerTranslator } = await import("@/i18n/server");
          const t = await getServerTranslator(null);

          if (params.action === "status") {
            const settings = await getTelegramIntegrationPublicSettings();
            return textResult(
              JSON.stringify(
                {
                  success: true,
                  connected: Boolean(settings.botToken),
                  mode: settings.detectedMode,
                  defaultProjectId: settings.defaultProjectId || null,
                  allowedUserIds: settings.allowedUserIds,
                  updatedAt: settings.updatedAt,
                },
                null,
                2
              )
            );
          }

          if (params.action === "disconnect") {
            const result = await disconnectTelegramBot(t);
            return textResult(
              JSON.stringify({ success: true, disconnected: true, ...result }, null, 2)
            );
          }

          const result = await connectTelegramBot({
            botToken: params.bot_token,
            mode: params.mode === "webhook" ? "webhook" : "polling",
            fallbackPublicBaseUrl: process.env.APP_BASE_URL?.trim(),
            t,
          });

          return textResult(
            JSON.stringify(
              {
                success: true,
                connected: true,
                mode: result.mode,
                botUsername: result.botUsername,
                botLink: result.botLink,
                webhookUrl: result.webhookUrl ?? null,
                claimWarning: result.claimWarning,
                note: "The bot is registered and receiving updates. Tell the user to open the bot link and send it a message. Do not repeat the token.",
              },
              null,
              2
            )
          );
        } catch (error) {
          return textResult(
            JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : "Telegram setup failed.",
                note: "Report this to the user as-is. Do not fall back to calling the Telegram API directly with curl: that can send a message but never connects the bot to this workspace.",
              },
              null,
              2
            )
          );
        }
      },
    }),
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
      label: "Create Eggent Workspace Skill",
      description: "Create a skill in an Eggent workspace: a project, or the orchestrator itself. The skill is passed to pi whenever that workspace runs as an agent.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id, or 'none' for the orchestrator. Defaults to the current workspace." })),
        skill_name: Type.String({ description: "Skill name, lowercase/hyphenated." }),
        description: Type.String({ description: "Skill description: what it does and when to use it." }),
        body: Type.String({ description: "SKILL.md body/instructions." }),
      }),
      execute: async (_toolCallId, params) => {
        const projectId = params.project_id || workspaceScopeId;
        if (!projectId) return textResult("No workspace selected; pass project_id, or 'none' for the orchestrator.");
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
      label: "Upsert Eggent Workspace MCP Server",
      description: "Create or update an MCP server in an Eggent workspace's .mcp.json — a project's, or the orchestrator's own. MCP tools are available through pi-mcp-adapter's mcp proxy tool when that workspace runs.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id, or 'none' for the orchestrator. Defaults to the current workspace." })),
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
        const projectId = params.project_id || workspaceScopeId;
        if (!projectId) return textResult("No workspace selected; pass project_id, or 'none' for the orchestrator.");
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
      label: "Delete Eggent Workspace MCP Server",
      description: "Delete an MCP server from an Eggent workspace configuration: a project's, or the orchestrator's own.",
      parameters: Type.Object({
        project_id: Type.Optional(Type.String({ description: "Project id, or 'none' for the orchestrator. Defaults to the current workspace." })),
        server_id: Type.String({ description: "MCP server id to delete." }),
      }),
      execute: async (_toolCallId, params) => {
        const projectId = params.project_id || workspaceScopeId;
        if (!projectId) return textResult("No workspace selected; pass project_id, or 'none' for the orchestrator.");
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
    ...(isUsageProviderConfigured()
      ? [defineTool({
        name: "eggent_usage_status",
        label: "Check Workspace Usage",
        description: "Report how much of this workspace's quota is used and how much is left, plus the current plan. Use this whenever the user asks about their balance, remaining credits or tokens, limits, quota, plan, trial, or how much they have left (\"сколько осталось\", \"какой у меня баланс\", \"сколько токенов\", \"я платный?\"). Always call this instead of guessing or saying the information is unavailable.",
        parameters: Type.Object({}),
        execute: async () => {
          const snapshot = await getUsageSnapshot();
          if (!snapshot) {
            return textResult(
              "Usage information is temporarily unavailable. Tell the user you could not read the current quota right now and suggest checking again shortly.",
              { available: false }
            );
          }

          const lines: string[] = [];
          if (snapshot.plan) {
            lines.push(`Plan: ${snapshot.plan.label}${snapshot.plan.endsAt ? ` (until ${snapshot.plan.endsAt})` : ""}`);
          }
          for (const meter of snapshot.meters) {
            lines.push(formatUsageMeter(meter));
          }
          if (snapshot.agentNote) {
            lines.push(`Important context: ${snapshot.agentNote}`);
          }
          if (snapshot.notice) {
            lines.push(`Notice: ${snapshot.notice.title} — ${snapshot.notice.body}`);
            if (snapshot.notice.actionUrl) {
              lines.push(`Action: ${snapshot.notice.actionLabel || "Open"} → ${snapshot.notice.actionUrl}`);
            }
          }
          lines.push("Report these numbers to the user directly and in their language, including any important context above.");
          return textResult(lines.join("\n"), { available: true, snapshot });
        },
      })]
      : []),
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
        quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Optional quality. Defaults to medium, which is a good balance of look and cost. Use high only when the user asks for maximum quality, since it costs several times more; auto/low are the cheapest and noticeably rougher." })),
        output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { description: "Output format. Defaults to png/provider default." })),
        background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")], { description: "Optional background mode." })),
      }),
      execute: async (_toolCallId, params) => {
        const backend = await resolveImageToolBackend();
        if (!backend) {
          // Say which of the two ways out applies rather than "not configured":
          // a workspace that left the included model has an image model to pick,
          // and coming back turns text and images on together.
          const state = await getImageGenerationState();
          return textResult(
            [
              "This workspace cannot generate images right now.",
              state.reason === "image_provider_not_connected" || state.reason === "image_provider_has_no_base_url"
                ? `The image provider selected in Settings (${state.providerId}) is not usable: connect it, or choose another one.`
                : "No image model is selected. Image generation is configured separately from the text model.",
              "Tell the user they have two options: choose an image provider and model in Settings, or switch back to the included Eggent AI model, which covers text and images together. Do not attempt image generation through other tools.",
            ].join("\n"),
            { configured: false, reason: state.reason || "image_backend_not_configured" }
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
          model: backend.model,
          prompt: params.prompt,
          n: Math.max(1, Math.min(10, Math.trunc(Number(params.n || 1)))) || 1,
        };
        if (params.size) body.size = params.size;
        if (params.resolution) body.resolution = params.resolution;
        if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
        // Providers treat "auto" as their cheapest tier, which produces visibly
        // poor images. Default to medium unless the caller asked for something
        // specific, and let "auto" through only when it was requested explicitly.
        body.quality = params.quality || "medium";
        if (params.output_format) body.output_format = params.output_format;
        if (params.background) body.background = params.background;
        if (inputReferences.length > 0) body.input_references = inputReferences;

        // The managed gateway exposes /images and routes by header; a provider
        // the user brought is plain OpenAI-compatible, so it gets the standard
        // /images/generations path and none of our routing headers.
        const endpoint = backend.managed ? `${backend.baseUrl}/images` : `${backend.baseUrl}/images/generations`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${backend.token}`,
            "Content-Type": "application/json",
            ...(backend.managed ? { "X-Eggent-AI-Request-Type": "image" } : {}),
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
        // The provider may report what this request cost. Eggent does not price
        // anything itself; it only passes the provider's own formatted figure on
        // so the user can connect the picture to the spend.
        const charge = extractProviderCharge(payload);
        const result = {
          success: true,
          provider: backend.providerLabel,
          imageCount: savedImages.length,
          images: savedImages,
          referenceImageCount: inputReferences.length,
          quality: body.quality,
          cost: charge?.formatted,
          note: [
            savedImages.length > 0
              ? "Generated image files were saved locally. Show the paths to the user and offer one short next action."
              : "Image provider returned no inline base64 images; inspect rawResponse for URLs or provider-specific output.",
            charge?.formatted
              ? `This request cost ${charge.formatted}. Tell the user that figure in one short sentence so image spend stays visible.`
              : "",
          ].filter(Boolean).join(" "),
          rawResponse: savedImages.length > 0 ? undefined : payload,
        };
        return textResult(JSON.stringify(result, null, 2), result);
      },
    }),
    defineTool({
      name: "eggent_memory_save",
      label: "Save Eggent Memory",
      description: "Save persistent memory for the current Eggent workspace: the selected project, or the orchestrator when no project is selected.",
      parameters: Type.Object({
        text: Type.String({ description: "Memory text to save." }),
        area: Type.Optional(Type.String({ description: "Memory area/category. Defaults to main." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No Eggent workspace scope is available for memory.");
        await appendProjectMemory(memoryProjectId, params.text, params.area || "main");
        return textResult("Saved to this workspace's memory.md.", { projectId: memoryProjectId, area: params.area || "main" });
      },
    }),
    defineTool({
      name: "eggent_memory_search",
      label: "Search Eggent Memory",
      description: "Search the current Eggent workspace's memory.md file: the selected project's, or the orchestrator's.",
      parameters: Type.Object({
        query: Type.String({ description: "Memory search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of memories. Defaults to 5." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No Eggent workspace scope is available for memory.");
        const output = await searchProjectMemory(memoryProjectId, params.query, params.limit || 5);
        return textResult(output, { projectId: memoryProjectId });
      },
    }),
    defineTool({
      name: "eggent_memory_delete",
      label: "Delete Eggent Memory",
      description: "Delete memory.md blocks matching a query for the current Eggent workspace.",
      parameters: Type.Object({
        query: Type.String({ description: "Query for memory.md blocks to delete." }),
      }),
      execute: async (_toolCallId, params) => {
        if (!memoryProjectId) return textResult("No Eggent workspace scope is available for memory.");
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

  // Registered on every run, including web ones with no Telegram attached.
  //
  // Providers cache a prompt by its exact prefix, and the tool list is part of
  // that prefix, so a tool that appears only on Telegram runs splits the fleet
  // into two cache lineages. The Telegram one stays warm because most traffic
  // arrives there; the web one goes cold, and a cold call costs about three
  // times a warm one. One list keeps both on the same warm prefix, and a run
  // with no Telegram channel simply says so when the tool is called.
  const telegramRuntime = getTelegramRuntimeData(options.toolRuntimeData);
  tools.push(defineTool({
      name: "telegram_send_file",
      label: "Send File to Telegram",
      description: "Send a local file to the current Telegram chat as a document. Use this when the user asks to send, return, export, download, or share a file in Telegram.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Absolute path to the file, or path relative to the current project cwd." }),
        caption: Type.Optional(Type.String({ description: "Optional caption to include with the file." })),
      }),
      execute: async (_toolCallId, params) => {
        if (!telegramRuntime) {
          return textResult(JSON.stringify({
            success: false,
            error: "This run is not attached to a Telegram chat, so there is nowhere to send the file.",
            note: "Tell the user the file is on disk and give its path. Offer Telegram only if they connect a bot.",
          }, null, 2));
        }
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

  return { tools, cleanup: async () => {} };
}
