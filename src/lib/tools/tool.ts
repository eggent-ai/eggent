import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import type { AgentContext } from "@/lib/agent/types";
import type { AppSettings, McpServerConfig } from "@/lib/types";
import { executeCode } from "@/lib/tools/code-execution";
import { memorySave, memoryLoad, memoryDelete } from "@/lib/tools/memory-tools";
import { knowledgeQuery } from "@/lib/tools/knowledge-query";
import { searchWeb } from "@/lib/tools/search-engine";
import { callSubordinate } from "@/lib/tools/call-subordinate";
import { createCronTool } from "@/lib/tools/cron-tool";
import { loadPdf } from "@/lib/memory/loaders/pdf-loader";
import {
  getAllProjects,
  createProject,
  getProject,
  getWorkDir,
  loadProjectSkillsMetadata,
  loadSkillInstructions,
  createSkill,
  updateSkill,
  deleteSkill,
  writeSkillFile,
  upsertProjectMcpServer,
  deleteProjectMcpServer,
} from "@/lib/storage/project-store";

const SKILL_RESOURCE_LIST_LIMIT = 60;
const SKILL_RESOURCE_READ_MAX_CHARS = 24000;
const CODE_EXEC_MAX_CHARS = 20000;
const CODE_EXEC_MAX_LINES = 800;
const TEXT_FILE_READ_MAX_CHARS = 30000;
const TEXT_FILE_WRITE_MAX_CHARS = 400000;
const PDF_FILE_READ_MAX_CHARS = 30000;
const TELEGRAM_SEND_FILE_MAX_BYTES = 45 * 1024 * 1024;

interface TelegramRuntimeData {
  botToken: string;
  chatId: string | number;
}

function getTelegramRuntimeData(context: AgentContext): TelegramRuntimeData | null {
  const raw = context.data?.telegram;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
  const chatIdRaw = record.chatId;
  const chatId =
    typeof chatIdRaw === "string" || typeof chatIdRaw === "number"
      ? chatIdRaw
      : null;
  if (!botToken || chatId === null) return null;
  return { botToken, chatId };
}

function resolveOutgoingFilePath(context: AgentContext, rawPath: string): string {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("file_path is required");
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }

  const cwd = resolveContextCwd(context);
  return path.resolve(cwd, value);
}

async function isExistingRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = path.normalize(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function resolveReadableFilePath(
  context: AgentContext,
  rawPath: string
): Promise<string> {
  const value = rawPath.trim();
  if (!value) {
    throw new Error("file_path is required");
  }

  const normalizedInput = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const candidates: string[] = [resolveOutgoingFilePath(context, value)];

  // Heuristic for accidental Unix absolute paths without a leading slash,
  // e.g. "Users/name/file.pdf" instead of "/Users/name/file.pdf".
  if (!path.isAbsolute(value) && /^(Users|home|var|tmp)\//.test(normalizedInput)) {
    candidates.push(path.resolve(path.sep, normalizedInput));
  }

  if (path.isAbsolute(value)) {
    candidates.push(path.resolve(value));
  }

  const chatId = context.chatId?.trim();
  if (chatId) {
    const chatFilesDir = path.join(process.cwd(), "data", "chat-files", chatId);
    const sanitized = value.replace(/^\.\/+/, "");

    if (!path.isAbsolute(value) && !sanitized.includes("/") && !sanitized.includes("\\")) {
      candidates.push(path.join(chatFilesDir, sanitized));
    }

    if (!path.isAbsolute(value)) {
      if (normalizedInput.startsWith("chat-files/")) {
        candidates.push(path.resolve(process.cwd(), "data", normalizedInput));
      } else if (normalizedInput.startsWith("data/chat-files/")) {
        candidates.push(path.resolve(process.cwd(), normalizedInput));
      }
    }
  }

  const uniqueCandidates = uniquePaths(candidates);
  for (const candidate of uniqueCandidates) {
    if (await isExistingRegularFile(candidate)) {
      return candidate;
    }
  }

  return uniqueCandidates[0];
}

function resolveContextCwd(context: AgentContext): string {
  const baseDir = getWorkDir(context.projectId);
  const rawCurrentPath = context.currentPath?.trim();
  if (!rawCurrentPath) {
    return baseDir;
  }

  // currentPath is expected to be project-relative; normalize absolute-like inputs ("/foo")
  // to stay inside the active project work directory.
  const normalized = path.normalize(rawCurrentPath).replace(/^[/\\]+/, "");
  const resolved = path.resolve(baseDir, normalized);

  if (
    resolved === baseDir ||
    resolved.startsWith(baseDir + path.sep)
  ) {
    return resolved;
  }

  return baseDir;
}

function normalizeContextPathForOutput(rawPath: string | null | undefined): string {
  const raw = rawPath?.trim();
  if (!raw) {
    return "";
  }
  const normalized = path.normalize(raw).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return normalized === "." ? "" : normalized;
}

function slugifyProjectId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || crypto.randomUUID().slice(0, 8)
  );
}

async function allocateProjectId(baseId: string): Promise<string> {
  const normalizedBase = slugifyProjectId(baseId);
  let candidate = normalizedBase;
  let counter = 2;
  while (await getProject(candidate)) {
    candidate = `${normalizedBase}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function parseLocalMarkdownLinks(markdown: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const regex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const rawTarget = match[1].trim();
    if (!rawTarget) continue;

    let target = rawTarget;
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1).trim();
    }

    const spaceQuoteIdx = target.search(/\s+["']/);
    if (spaceQuoteIdx >= 0) {
      target = target.slice(0, spaceQuoteIdx).trim();
    }

    const lower = target.toLowerCase();
    if (
      lower.startsWith("http://") ||
      lower.startsWith("https://") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("#")
    ) {
      continue;
    }

    const cleaned = target.split("#")[0].split("?")[0].trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }

  return result;
}

function inferLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
      return "javascript";
    case ".jsx":
      return "jsx";
    case ".py":
      return "python";
    case ".sh":
      return "bash";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".sql":
      return "sql";
    default:
      return "text";
  }
}

async function resolveSkillLocalFile(
  skillDir: string,
  relativePath: string
): Promise<string | null> {
  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, "");
  if (!normalized || normalized.includes("..")) return null;

  const skillRoot = path.resolve(skillDir);
  const fullPath = path.resolve(skillRoot, normalized);
  if (!fullPath.startsWith(skillRoot + path.sep) && fullPath !== skillRoot) {
    return null;
  }

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return null;
    return fullPath;
  } catch {
    return null;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function collectSkillFilesRecursive(
  rootDir: string,
  skillDir: string,
  limit: number
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && results.length < limit) {
    const dir = queue.shift()!;
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(skillDir, fullPath).replaceAll("\\", "/");
      results.push(relative);
    }
  }

  return results;
}

async function listSkillResourcePaths(
  skillDir: string,
  skillBody: string
): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (value: string) => {
    if (seen.has(value) || result.length >= SKILL_RESOURCE_LIST_LIMIT) return;
    seen.add(value);
    result.push(value);
  };

  const links = parseLocalMarkdownLinks(skillBody);
  for (const link of links) {
    if (result.length >= SKILL_RESOURCE_LIST_LIMIT) break;
    const fullPath = await resolveSkillLocalFile(skillDir, link);
    if (!fullPath) continue;
    const relative = path.relative(skillDir, fullPath).replaceAll("\\", "/");
    pushUnique(relative);
  }

  const resourceDirs = ["references", "scripts", "assets"];
  for (const dirName of resourceDirs) {
    if (result.length >= SKILL_RESOURCE_LIST_LIMIT) break;
    const dirPath = path.join(skillDir, dirName);
    if (!(await isDirectory(dirPath))) continue;
    const remaining = SKILL_RESOURCE_LIST_LIMIT - result.length;
    const files = await collectSkillFilesRecursive(dirPath, skillDir, remaining);
    for (const file of files) {
      pushUnique(file);
    }
  }

  return result;
}

/**
 * Create all agent tools based on context and settings
 */
export function createAgentTools(
  context: AgentContext,
  settings: AppSettings
): ToolSet {
  const tools: ToolSet = {};

  // Project navigation tools
  tools.list_projects = tool({
    description: "List all projects.",
    inputSchema: z.object({}),
    execute: async () => {
      const projects = await getAllProjects();
      return {
        success: true,
        activeProjectId: context.projectId ?? null,
        activeProjectName: context.projectId
          ? (await getProject(context.projectId))?.name ?? null
          : null,
        count: projects.length,
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          updatedAt: project.updatedAt,
        })),
      };
    },
  });

  tools.get_current_project = tool({
    description: "Get current project context (name, path, workDir).",
    inputSchema: z.object({}),
    execute: async () => {
      if (!context.projectId) {
        return {
          success: true,
          isGlobal: true,
          projectId: null,
          projectName: null,
          currentPath: normalizeContextPathForOutput(context.currentPath),
          workDir: getWorkDir(undefined),
          message: "No project is selected (global context).",
        };
      }

      const project = await getProject(context.projectId);
      return {
        success: true,
        isGlobal: false,
        projectId: context.projectId,
        projectName: project?.name ?? null,
        currentPath: normalizeContextPathForOutput(context.currentPath),
        workDir: getWorkDir(context.projectId),
      };
    },
  });

  tools.switch_project = tool({
    description: "Switch to another project by ID or name.",
    inputSchema: z
      .object({
        project_id: z
          .string()
          .optional()
          .describe("Project ID"),
        project_name: z
          .string()
          .optional()
          .describe("Project name"),
      })
      .refine(
        (value) => Boolean(value.project_id?.trim() || value.project_name?.trim()),
        "Provide project_id or project_name"
      ),
    execute: async ({ project_id, project_name }) => {
      const projects = await getAllProjects();
      if (projects.length === 0) {
        return {
          success: false,
          action: "switch_project",
          error: "No projects available. Create a project first.",
        };
      }

      const idQuery = project_id?.trim() ?? "";
      const nameQuery = project_name?.trim().toLowerCase() ?? "";
      let target = idQuery
        ? projects.find((project) => project.id === idQuery)
        : undefined;

      if (!target && nameQuery) {
        const exactMatches = projects.filter(
          (project) =>
            project.name.trim().toLowerCase() === nameQuery ||
            project.id.trim().toLowerCase() === nameQuery
        );

        if (exactMatches.length === 1) {
          target = exactMatches[0];
        } else if (exactMatches.length > 1) {
          return {
            success: false,
            action: "switch_project",
            error: `Ambiguous project name "${project_name}".`,
            matches: exactMatches.map((project) => ({
              id: project.id,
              name: project.name,
            })),
          };
        }
      }

      if (!target && nameQuery) {
        const partialMatches = projects.filter(
          (project) =>
            project.name.toLowerCase().includes(nameQuery) ||
            project.id.toLowerCase().includes(nameQuery)
        );

        if (partialMatches.length === 1) {
          target = partialMatches[0];
        } else if (partialMatches.length > 1) {
          return {
            success: false,
            action: "switch_project",
            error: `Project query "${project_name}" is ambiguous.`,
            matches: partialMatches.map((project) => ({
              id: project.id,
              name: project.name,
            })),
          };
        }
      }

      if (!target) {
        return {
          success: false,
          action: "switch_project",
          error:
            idQuery.length > 0
              ? `Project with id "${idQuery}" not found.`
              : `Project "${project_name}" not found.`,
          availableProjects: projects.map((project) => ({
            id: project.id,
            name: project.name,
          })),
        };
      }

      return {
        success: true,
        action: "switch_project",
        projectId: target.id,
        projectName: target.name,
        currentPath: "",
        message: `Switching to project "${target.name}" (${target.id}).`,
      };
    },
  });

  tools.create_project = tool({
    description: "Create a new project.",
    inputSchema: z.object({
      name: z.string().describe("Project name"),
      description: z.string().optional(),
      instructions: z.string().optional(),
      memory_mode: z.enum(["global", "isolated"]).optional(),
      project_id: z.string().optional(),
    }),
    execute: async ({
      name,
      description,
      instructions,
      memory_mode,
      project_id,
    }) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return {
          success: false,
          action: "create_project",
          error: "Project name is required.",
        };
      }

      const preferredId = project_id?.trim()
        ? slugifyProjectId(project_id)
        : slugifyProjectId(trimmedName);
      const id = await allocateProjectId(preferredId);

      try {
        const project = await createProject({
          id,
          name: trimmedName,
          description: (description ?? "").trim(),
          instructions: (instructions ?? "").trim(),
          memoryMode: memory_mode ?? "isolated",
        });
        return {
          success: true,
          action: "create_project",
          projectId: project.id,
          projectName: project.name,
          message: `Project "${project.name}" created with id "${project.id}".`,
        };
      } catch (error) {
        return {
          success: false,
          action: "create_project",
          error:
            error instanceof Error
              ? error.message
              : "Failed to create project.",
        };
      }
    },
  });

  // Code execution tool
  if (settings.codeExecution.enabled) {
    tools.code_execution = tool({
      description: "Execute code in a persistent shell session.",
      inputSchema: z.object({
        runtime: z
          .enum(["python", "nodejs", "terminal"]),
        code: z
          .string()
          .describe("Code to execute"),
        session: z
          .number()
          .default(0)
          .describe("Session ID (0-9), default 0"),
      }),
      execute: async ({ runtime, code, session }) => {
        const normalizedCode = code.replace(/\r\n/g, "\n");
        const sanitizedCode = normalizedCode.replace(/\s+$/, "");
        const lineCount = sanitizedCode.length === 0 ? 0 : sanitizedCode.split("\n").length;
        if (sanitizedCode.length === 0) {
          return "[Preflight error] Empty code payload.";
        }
        if (sanitizedCode.length > CODE_EXEC_MAX_CHARS) {
          return `[Preflight error] Code payload too large (${sanitizedCode.length} chars). Limit is ${CODE_EXEC_MAX_CHARS}. Split the task into smaller executions.`;
        }
        if (lineCount > CODE_EXEC_MAX_LINES) {
          return `[Preflight error] Code payload has too many lines (${lineCount}). Limit is ${CODE_EXEC_MAX_LINES}. Split the task into smaller executions.`;
        }
        const cwd = resolveContextCwd(context);
        return executeCode(runtime, sanitizedCode, session, settings.codeExecution, cwd);
      },
    });
  }

  tools.read_text_file = tool({
    description: "Read a local UTF-8 text file.",
    inputSchema: z.object({
      file_path: z.string().describe("File path (absolute or relative)"),
      start_line: z.number().int().min(1).default(1),
      max_lines: z.number().int().min(1).max(2000).default(300),
      max_chars: z.number().int().min(200).max(TEXT_FILE_READ_MAX_CHARS).default(12000),
    }),
    execute: async ({ file_path, start_line, max_lines, max_chars }) => {
      try {
        const resolvedPath = await resolveReadableFilePath(context, file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${resolvedPath}`,
          };
        }

        const raw = await fs.readFile(resolvedPath, "utf-8");
        if (raw.includes("\u0000")) {
          return {
            success: false,
            error: `File appears to be binary and is not suitable for read_text_file: ${resolvedPath}`,
          };
        }

        const normalized = raw.replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        const startIndex = Math.max(0, start_line - 1);
        const endIndex = Math.min(lines.length, startIndex + max_lines);
        const selected = lines.slice(startIndex, endIndex).join("\n");
        const truncatedByChars = selected.length > max_chars;
        const content = truncatedByChars
          ? `${selected.slice(0, max_chars)}\n\n[Truncated by max_chars]`
          : selected;
        const language = inferLanguageFromPath(resolvedPath);

        return {
          success: true,
          path: resolvedPath,
          size: stat.size,
          totalLines: lines.length,
          startLine: startIndex + 1,
          endLine: endIndex,
          truncated: truncatedByChars || endIndex < lines.length,
          language,
          content,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to read text file.",
        };
      }
    },
  });

  tools.read_pdf_file = tool({
    description:
      "Read text from a local PDF file.",
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("File path"),
      max_chars: z.number().int().min(200).max(PDF_FILE_READ_MAX_CHARS).default(15000),
    }),
    execute: async ({ file_path, max_chars }) => {
      try {
        const resolvedPath = await resolveReadableFilePath(context, file_path);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          return {
            success: false,
            error: `Path is not a file: ${resolvedPath}`,
          };
        }

        const parsed = await loadPdf(resolvedPath);
        const text = (parsed.text ?? "").trim();
        const truncated = text.length > max_chars;
        const content = truncated
          ? `${text.slice(0, max_chars)}\n\n[Truncated by max_chars]`
          : text;

        return {
          success: true,
          path: resolvedPath,
          size: stat.size,
          metadata: parsed.metadata,
          extractedChars: text.length,
          truncated,
          content,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to read PDF file.",
        };
      }
    },
  });

  tools.write_text_file = tool({
    description:
      "Write or overwrite a local UTF-8 text file.",
    inputSchema: z.object({
      file_path: z.string().describe("File path"),
      content: z.string().describe("File content"),
      overwrite: z.boolean().default(true),
    }),
    execute: async ({ file_path, content, overwrite }) => {
      try {
        if (content.length > TEXT_FILE_WRITE_MAX_CHARS) {
          return {
            success: false,
            error: `Content too large (${content.length} chars). Max allowed is ${TEXT_FILE_WRITE_MAX_CHARS}.`,
          };
        }

        const resolvedPath = resolveOutgoingFilePath(context, file_path);
        let existed = false;
        try {
          const before = await fs.stat(resolvedPath);
          if (!before.isFile()) {
            return {
              success: false,
              error: `Target exists and is not a regular file: ${resolvedPath}`,
            };
          }
          existed = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }

        if (existed && !overwrite) {
          return {
            success: false,
            error: `File already exists and overwrite=false: ${resolvedPath}`,
          };
        }

        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, content, "utf-8");
        const after = await fs.stat(resolvedPath);

        return {
          success: true,
          path: resolvedPath,
          bytes: after.size,
          created: !existed,
          overwritten: existed,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to write text file.",
        };
      }
    },
  });

  tools.copy_file = tool({
    description:
      "Copy a file.",
    inputSchema: z.object({
      source_path: z
        .string()
        .describe("Source path"),
      destination_path: z.string().describe("Destination path"),
      overwrite: z.boolean().default(false),
    }),
    execute: async ({ source_path, destination_path, overwrite }) => {
      try {
        const sourceResolved = resolveOutgoingFilePath(context, source_path);
        const destinationResolved = resolveOutgoingFilePath(context, destination_path);

        if (sourceResolved === destinationResolved) {
          return {
            success: false,
            error: "source_path and destination_path must be different.",
          };
        }

        const sourceStat = await fs.stat(sourceResolved);
        if (!sourceStat.isFile()) {
          return {
            success: false,
            error: `Source is not a file: ${sourceResolved}`,
          };
        }

        await fs.mkdir(path.dirname(destinationResolved), { recursive: true });
        await fs.copyFile(
          sourceResolved,
          destinationResolved,
          overwrite ? 0 : fsConstants.COPYFILE_EXCL
        );
        const destinationStat = await fs.stat(destinationResolved);

        return {
          success: true,
          sourcePath: sourceResolved,
          destinationPath: destinationResolved,
          bytes: destinationStat.size,
          overwritten: overwrite,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to copy file.",
        };
      }
    },
  });

  // Memory tools
  if (settings.memory.enabled) {
    tools.memory_save = tool({
      description: "Save information to persistent memory.",
      inputSchema: z.object({
        text: z
          .string()
          .describe("Text to save"),
        area: z
          .enum(["main", "fragments", "solutions", "instruments"])
          .default("main"),
      }),
      execute: async ({ text, area }) => {
        return memorySave(text, area, context.memorySubdir, settings);
      },
    });

    tools.memory_load = tool({
      description: "Search persistent memory.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().default(5),
      }),
      execute: async ({ query, limit }) => {
        return memoryLoad(query, limit, context.memorySubdir, settings);
      },
    });

    tools.memory_delete = tool({
      description: "Delete entries from persistent memory.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        return memoryDelete(query, context.memorySubdir, settings);
      },
    });
  }

  // Knowledge query tool
  tools.knowledge_query = tool({
    description: "Search uploaded documents (knowledge base).",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().default(5),
    }),
    execute: async ({ query, limit }) => {
      return knowledgeQuery(query, limit, context.knowledgeSubdirs, settings);
    },
  });

  // Search engine tool
  if (settings.search.enabled && settings.search.provider !== "none") {
    tools.search_web = tool({
      description: "Search the internet.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().default(5),
      }),
      execute: async ({ query, limit }) => {
        return searchWeb(query, limit, settings.search);
      },
    });
  }

  const telegramRuntime = getTelegramRuntimeData(context);
  if (telegramRuntime) {
    tools.telegram_send_file = tool({
      description: "Send a file to the current Telegram chat.",
      inputSchema: z.object({
        file_path: z
          .string()
          .describe("File path"),
        caption: z.string().optional(),
      }),
      execute: async ({ file_path, caption }) => {
        try {
          const resolvedPath = resolveOutgoingFilePath(context, file_path);
          const stat = await fs.stat(resolvedPath);
          if (!stat.isFile()) {
            return {
              success: false,
              error: `Path is not a file: ${resolvedPath}`,
            };
          }
          if (stat.size > TELEGRAM_SEND_FILE_MAX_BYTES) {
            return {
              success: false,
              error: `File is too large (${stat.size} bytes). Max allowed is ${TELEGRAM_SEND_FILE_MAX_BYTES} bytes.`,
            };
          }

          const fileBuffer = await fs.readFile(resolvedPath);
          const form = new FormData();
          form.append("chat_id", String(telegramRuntime.chatId));
          form.append(
            "document",
            new Blob([fileBuffer]),
            path.basename(resolvedPath)
          );
          const trimmedCaption = caption?.trim();
          if (trimmedCaption) {
            form.append("caption", trimmedCaption);
          }

          const response = await fetch(
            `https://api.telegram.org/bot${telegramRuntime.botToken}/sendDocument`,
            {
              method: "POST",
              body: form,
            }
          );
          const payload = (await response.json().catch(() => null)) as
            | {
                ok?: boolean;
                description?: string;
                result?: {
                  document?: {
                    file_id?: string;
                    file_name?: string;
                    file_size?: number;
                  };
                };
              }
            | null;

          if (!response.ok || !payload?.ok) {
            return {
              success: false,
              error: `Telegram sendDocument failed (${response.status})${payload?.description ? `: ${payload.description}` : ""}`,
            };
          }

          return {
            success: true,
            message: "File sent to Telegram successfully.",
            path: resolvedPath,
            name: payload.result?.document?.file_name || path.basename(resolvedPath),
            size: payload.result?.document?.file_size ?? stat.size,
            telegramFileId: payload.result?.document?.file_id ?? null,
          };
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to send file to Telegram.",
          };
        }
      },
    });
  }

  tools.cron = createCronTool(context);

  // Load skill tool — load full instructions when model activates a project skill (Agent Skills integrate-skills)
  if (context.projectId) {
    tools.load_skill = tool({
      description: "Load full instructions for a project skill by name.",
      inputSchema: z.object({
        skill_name: z.string().describe("Skill name"),
      }),
      execute: async ({ skill_name }) => {
        const skill = await loadSkillInstructions(
          context.projectId!,
          skill_name.trim()
        );
        if (!skill) {
          const meta = await loadProjectSkillsMetadata(context.projectId!);
          const names = meta.map((s) => s.name).join(", ");
          return `Skill "${skill_name}" not found. Available skills: ${names || "none"}.`;
        }
        const resourcePaths = await listSkillResourcePaths(
          skill.skillDir,
          skill.body
        );
        const parts = [
          `# Skill: ${skill.name}\n${skill.description}\n\n## Instructions\n\n${skill.body}`,
        ];
        if (resourcePaths.length > 0) {
          parts.push(
            "## Available Skill Resources\n" +
            "Use `load_skill_resource` to load one specific file when the instructions need it.\n\n" +
            resourcePaths.map((p) => `- \`${p}\``).join("\n")
          );
        } else {
          parts.push(
            "## Available Skill Resources\nNo additional resource files were detected for this skill."
          );
        }
        if (skill.compatibility) {
          parts.push(`**Compatibility:** ${skill.compatibility}`);
        }
        parts.push(
          `\nSkill directory: \`${skill.skillDir}\` (may contain references/, scripts/, assets/).`
        );
        return parts.join("\n");
      },
    });

    tools.load_skill_resource = tool({
      description: "Load a resource file from a project skill.",
      inputSchema: z.object({
        skill_name: z.string().describe("Skill name"),
        relative_path: z.string().describe("Path relative to skill dir"),
      }),
      execute: async ({ skill_name, relative_path }) => {
        const skill = await loadSkillInstructions(
          context.projectId!,
          skill_name.trim()
        );
        if (!skill) {
          const meta = await loadProjectSkillsMetadata(context.projectId!);
          const names = meta.map((s) => s.name).join(", ");
          return `Skill "${skill_name}" not found. Available skills: ${names || "none"}.`;
        }

        const fullPath = await resolveSkillLocalFile(
          skill.skillDir,
          relative_path.trim()
        );
        if (!fullPath) {
          return `Resource "${relative_path}" was not found in skill "${skill.name}" or path is invalid.`;
        }

        let raw: string;
        try {
          raw = await fs.readFile(fullPath, "utf-8");
        } catch {
          return `Failed to read resource "${relative_path}" for skill "${skill.name}".`;
        }

        const truncated = raw.length > SKILL_RESOURCE_READ_MAX_CHARS;
        const content = truncated
          ? `${raw.slice(0, SKILL_RESOURCE_READ_MAX_CHARS)}\n\n[Truncated: file too large]`
          : raw;
        const relative = path.relative(skill.skillDir, fullPath).replaceAll("\\", "/");
        const language = inferLanguageFromPath(fullPath);

        return [
          `# Skill Resource: ${skill.name}/${relative}`,
          "",
          `\`\`\`${language}`,
          content,
          "```",
        ].join("\n");
      },
    });

    tools.create_skill = tool({
      description: "Create a new project skill (lowercase-hyphen name).",
      inputSchema: z.object({
        skill_name: z.string().describe("lowercase-hyphen name"),
        description: z.string().describe("What the skill does"),
        body: z.string().describe("Markdown instructions"),
        compatibility: z.string().optional(),
        license: z.string().optional(),
      }),
      execute: async ({ skill_name, description, body, compatibility, license }) => {
        const result = await createSkill(context.projectId!, {
          skill_name,
          description,
          body: body ?? "",
          compatibility,
          license,
        });
        if (result.success) {
          return `Skill "${result.skillDir.split(/[/\\]/).pop()}" created successfully at ${result.skillDir}/SKILL.md. It will appear in <available_skills> for this project.`;
        }
        return `Failed to create skill: ${result.error}`;
      },
    });

    tools.update_skill = tool({
      description: "Update an existing project skill.",
      inputSchema: z.object({
        skill_name: z.string().describe("Skill name"),
        description: z.string().optional(),
        body: z.string().optional(),
        compatibility: z.string().nullable().optional(),
        license: z.string().nullable().optional(),
      }),
      execute: async ({ skill_name, description, body, compatibility, license }) => {
        const payload: {
          skill_name: string;
          description?: string;
          body?: string;
          compatibility?: string | null;
          license?: string | null;
        } = { skill_name: skill_name.trim() };
        if (description !== undefined) payload.description = description;
        if (body !== undefined) payload.body = body;
        if (compatibility !== undefined) payload.compatibility = compatibility;
        if (license !== undefined) payload.license = license;

        const result = await updateSkill(context.projectId!, payload);
        if (result.success) {
          return `Skill "${skill_name.trim()}" updated successfully at ${result.skillFilePath}.`;
        }
        return `Failed to update skill: ${result.error}`;
      },
    });

    tools.delete_skill = tool({
      description: "Delete a project skill.",
      inputSchema: z.object({
        skill_name: z.string().describe("Exact skill name to delete."),
        confirm: z
          .boolean()
          .default(false)
          .describe("Safety confirmation. Must be true to perform deletion."),
      }),
      execute: async ({ skill_name, confirm }) => {
        if (!confirm) {
          return 'Deletion not executed. Set confirm=true to delete the skill directory permanently.';
        }
        const result = await deleteSkill(context.projectId!, skill_name.trim());
        if (result.success) {
          return `Skill "${skill_name.trim()}" deleted successfully from ${result.skillDir}.`;
        }
        return `Failed to delete skill: ${result.error}`;
      },
    });

    tools.write_skill_file = tool({
      description: "Write a file into a project skill directory (scripts/, references/, assets/).",
      inputSchema: z.object({
        skill_name: z.string().describe("Skill name"),
        relative_path: z.string().describe("Path relative to skill dir"),
        content: z.string().describe("File content"),
      }),
      execute: async ({ skill_name, relative_path, content }) => {
        const result = await writeSkillFile(
          context.projectId!,
          skill_name.trim(),
          relative_path.trim(),
          content ?? ""
        );
        if (result.success) {
          const short = result.filePath.replace(/^.*[/\\](?:skills|instructions)[/\\]/, "");
          return `File written: ${short}`;
        }
        return `Failed: ${result.error}`;
      },
    });

    tools.upsert_mcp_server = tool({
      description: "Create or update an MCP server entry for this project.",
      inputSchema: z
        .object({
          id: z.string().describe("Server id"),
          transport: z.enum(["stdio", "http"]),
          command: z.string().nullable().optional().describe("stdio: executable"),
          args: z.array(z.string()).nullable().optional(),
          env: z.record(z.string(), z.string()).nullable().optional(),
          cwd: z.string().nullable().optional(),
          url: z.string().nullable().optional().describe("http: endpoint URL"),
          headers: z.record(z.string(), z.string()).nullable().optional(),
        })
        .superRefine((value, ctx) => {
          if (value.transport === "stdio" && !(value.command ?? "").trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "command is required when transport is stdio.",
              path: ["command"],
            });
          }
          if (value.transport === "http" && !(value.url ?? "").trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "url is required when transport is http.",
              path: ["url"],
            });
          }
        }),
      execute: async (payload) => {
        const server: McpServerConfig =
          payload.transport === "http"
            ? {
                id: payload.id,
                transport: "http",
                url: payload.url ?? "",
                headers: payload.headers ?? undefined,
              }
            : {
                id: payload.id,
                transport: "stdio",
                command: payload.command ?? "",
                args: payload.args ?? undefined,
                env: payload.env ?? undefined,
                cwd: payload.cwd ?? undefined,
              };
        const result = await upsertProjectMcpServer(
          context.projectId!,
          server
        );
        if (result.success) {
          return `MCP server "${payload.id}" ${result.action} in ${result.filePath}.`;
        }
        return `Failed to upsert MCP server: ${result.error}`;
      },
    });

    tools.delete_mcp_server = tool({
      description: "Delete an MCP server entry from this project.",
      inputSchema: z.object({
        server_id: z.string().describe("Server id"),
      }),
      execute: async ({ server_id }) => {
        const result = await deleteProjectMcpServer(context.projectId!, server_id);
        if (result.success) {
          return `MCP server "${server_id}" deleted from ${result.filePath}.`;
        }
        return `Failed to delete MCP server: ${result.error}`;
      },
    });
  }

  // Call subordinate tool (only for agents below max depth)
  if ((context.agentNumber ?? 0) < 3) {
    tools.call_subordinate = tool({
      description: "Delegate a subtask to a subordinate agent.",
      inputSchema: z.object({
        task: z.string().describe("Task description with context"),
      }),
      execute: async ({ task }) => {
        return callSubordinate(
          task,
          context.projectId,
          context.agentNumber,
          context.history
        );
      },
    });
  }

  return tools;
}
