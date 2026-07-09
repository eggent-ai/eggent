import fs from "fs/promises";
import path from "path";
import {
  Project,
  type ProjectSkill,
  type ProjectSkillMetadata,
  type ProjectMcpConfig,
  type McpServerConfig,
  type McpServersFileCursor,
} from "@/lib/types";
import { deleteChatsByProjectId } from "@/lib/storage/chat-store";
import { clearMemoryCache } from "@/lib/memory/memory";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";

const DATA_DIR = path.join(process.cwd(), "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

/** ID used for "No Project (Global)" — work dir is data/projects */
export const GLOBAL_PROJECT_ID = "none";

/**
 * Resolve work directory for a project or global context.
 * When projectId is null/undefined or GLOBAL_PROJECT_ID ("none"), returns data/projects.
 */
export function getWorkDir(projectId?: string | null): string {
  if (!projectId || projectId === GLOBAL_PROJECT_ID) return PROJECTS_DIR;
  return path.join(PROJECTS_DIR, projectId);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export const PROJECT_CONTEXT_FILENAME = "context.md";
export const PROJECT_MEMORY_FILENAME = "memory.md";
export const PROJECT_SKILLS_DIRNAME = "skills";
export const PROJECT_MCP_FILENAME = "mcp.json";
export const PROJECT_CRON_FILENAME = "cron.json";
export const PROJECT_MODEL_FILENAME = "model.json";
export const PROJECT_METADATA_FILENAME = "project.json";

function projectDir(projectId: string) {
  return path.join(PROJECTS_DIR, projectId);
}

function projectMetaDir(projectId: string) {
  return path.join(projectDir(projectId), ".meta");
}

function projectMetaFile(projectId: string) {
  return path.join(projectDir(projectId), PROJECT_METADATA_FILENAME);
}

function legacyProjectMetaFile(projectId: string) {
  return path.join(projectMetaDir(projectId), "project.json");
}

export function getProjectContextPath(projectId: string): string {
  return path.join(projectDir(projectId), PROJECT_CONTEXT_FILENAME);
}

export function getProjectMemoryPath(projectId: string): string {
  return path.join(projectDir(projectId), PROJECT_MEMORY_FILENAME);
}

export function getProjectModelSettingsPath(projectId: string): string {
  return path.join(projectDir(projectId), PROJECT_MODEL_FILENAME);
}

/** Path to project's skills directory — Agent Skills spec */
export function getProjectSkillsDir(projectId: string): string {
  return path.join(projectDir(projectId), PROJECT_SKILLS_DIRNAME);
}

/** Legacy path to project's .meta/instructions directory (kept for compatibility/migration). */
function getProjectLegacyInstructionsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "instructions");
}

function getProjectLegacySkillsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "skills");
}

/** @deprecated Use getProjectSkillsDir. Kept for compatibility with existing imports. */
export function getProjectInstructionsDir(projectId: string): string {
  return getProjectSkillsDir(projectId);
}

/** Project root directory where mcp.json lives. */
export function getProjectMcpDir(projectId: string): string {
  return projectDir(projectId);
}

/** Path to project's root mcp.json */
export function getProjectMcpServersPath(projectId: string): string {
  return path.join(projectDir(projectId), PROJECT_MCP_FILENAME);
}

/**
 * Normalize Cursor-style mcpServers object to ProjectMcpConfig.
 * Entry with `url` → http; otherwise `command` → stdio.
 */
function normalizeMcpServersFile(parsed: unknown): ProjectMcpConfig | null {
  // Cursor format: { mcpServers: { [id]: { command, args?, env? } | { url, headers? } } }
  const cursor = parsed as McpServersFileCursor;
  if (cursor?.mcpServers && typeof cursor.mcpServers === "object") {
    const servers: McpServerConfig[] = [];
    for (const [id, val] of Object.entries(cursor.mcpServers)) {
      if (!val || typeof val !== "object") continue;
      if ("url" in val && typeof val.url === "string") {
        servers.push({
          id,
          transport: "http",
          url: val.url,
          headers: val.headers,
        });
      } else if ("command" in val && typeof val.command === "string") {
        servers.push({
          id,
          transport: "stdio",
          command: val.command,
          args: Array.isArray(val.args) ? val.args : [],
          env: val.env,
          cwd: val.cwd,
        });
      }
    }
    if (servers.length === 0) return null;
    return { servers };
  }
  // Legacy format: { servers: [ { id, transport, ... } ] }
  const legacy = parsed as ProjectMcpConfig;
  if (Array.isArray(legacy?.servers) && legacy.servers.every((s) => s?.id && s?.transport)) {
    return legacy;
  }
  return null;
}

/**
 * Load MCP servers config for a project. Returns null if file missing or invalid.
 * Supports Cursor format (mcpServers object) and legacy format (servers array).
 */
export async function loadProjectMcpServers(
  projectId: string
): Promise<ProjectMcpConfig | null> {
  const filePath = getProjectMcpServersPath(projectId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return normalizeMcpServersFile(parsed);
  } catch {
    return null;
  }
}

function normalizeStringRecord(
  value: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!value) return undefined;
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.trim();
    if (!key) continue;
    normalized[key] = String(v);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toCursorMcpServersFile(config: ProjectMcpConfig): McpServersFileCursor {
  const mcpServers: McpServersFileCursor["mcpServers"] = {};
  for (const server of config.servers) {
    if (server.transport === "http") {
      const headers = normalizeStringRecord(server.headers);
      mcpServers[server.id] = headers
        ? { url: server.url, headers }
        : { url: server.url };
      continue;
    }

    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = normalizeStringRecord(server.env);
    const stdioEntry: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    } = { command: server.command };
    if (args && args.length > 0) stdioEntry.args = args;
    if (env) stdioEntry.env = env;
    if (server.cwd?.trim()) stdioEntry.cwd = server.cwd.trim();
    mcpServers[server.id] = stdioEntry;
  }
  return { mcpServers };
}

async function loadProjectMcpServersFileCursor(
  projectId: string
): Promise<McpServersFileCursor> {
  const filePath = getProjectMcpServersPath(projectId);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    const cursor = parsed as McpServersFileCursor;
    if (cursor?.mcpServers && typeof cursor.mcpServers === "object") {
      const normalized = normalizeMcpServersFile(parsed);
      if (normalized) return toCursorMcpServersFile(normalized);
      return { mcpServers: {} };
    }

    const normalized = normalizeMcpServersFile(parsed);
    if (normalized) return toCursorMcpServersFile(normalized);
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

function validateMcpServerId(value: string): string | null {
  const id = value.trim();
  if (!id) return "MCP server id is required.";
  if (id.length > 120) return "MCP server id must be at most 120 characters.";
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    return "MCP server id may contain only letters, numbers, dots, underscores, and hyphens.";
  }
  return null;
}

export async function upsertProjectMcpServer(
  projectId: string,
  server: McpServerConfig
): Promise<
  | { success: true; filePath: string; action: "created" | "updated" }
  | { success: false; error: string }
> {
  const id = server.id.trim();
  const idErr = validateMcpServerId(id);
  if (idErr) return { success: false, error: idErr };

  const cursor = await loadProjectMcpServersFileCursor(projectId);
  const existed = Object.prototype.hasOwnProperty.call(cursor.mcpServers, id);

  if (server.transport === "http") {
    const url = server.url.trim();
    if (!url) return { success: false, error: "HTTP MCP server url is required." };
    const headers = normalizeStringRecord(server.headers);
    cursor.mcpServers[id] = headers ? { url, headers } : { url };
  } else {
    const command = server.command.trim();
    if (!command) {
      return { success: false, error: "STDIO MCP server command is required." };
    }
    const args = Array.isArray(server.args)
      ? server.args.map((a) => a.trim()).filter((a) => a.length > 0)
      : undefined;
    const env = normalizeStringRecord(server.env);
    const stdioEntry: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    } = { command };
    if (args && args.length > 0) stdioEntry.args = args;
    if (env) stdioEntry.env = env;
    if (server.cwd?.trim()) stdioEntry.cwd = server.cwd.trim();
    cursor.mcpServers[id] = stdioEntry;
  }

  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await fs.writeFile(filePath, JSON.stringify(cursor, null, 2), "utf-8");
  return { success: true, filePath, action: existed ? "updated" : "created" };
}

export async function deleteProjectMcpServer(
  projectId: string,
  serverId: string
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  const id = serverId.trim();
  const idErr = validateMcpServerId(id);
  if (idErr) return { success: false, error: idErr };

  const cursor = await loadProjectMcpServersFileCursor(projectId);
  if (!Object.prototype.hasOwnProperty.call(cursor.mcpServers, id)) {
    return { success: false, error: `MCP server "${id}" not found.` };
  }

  delete cursor.mcpServers[id];
  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await fs.writeFile(filePath, JSON.stringify(cursor, null, 2), "utf-8");
  return { success: true, filePath };
}

export async function saveProjectMcpServersContent(
  projectId: string,
  rawContent: string
): Promise<
  | {
      success: true;
      filePath: string;
      content: string;
      servers: McpServerConfig[];
    }
  | { success: false; error: string }
> {
  const trimmed = rawContent.trim();
  const defaultContent = JSON.stringify({ mcpServers: {} }, null, 2);
  const parseTarget = trimmed ? rawContent : defaultContent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(parseTarget);
  } catch {
    return {
      success: false,
      error: "Invalid JSON. Provide a valid mcp.json object.",
    };
  }

  const maybeCursor = parsed as McpServersFileCursor;
  const isCursorObject =
    maybeCursor?.mcpServers &&
    typeof maybeCursor.mcpServers === "object" &&
    !Array.isArray(maybeCursor.mcpServers);

  const normalized = normalizeMcpServersFile(parsed);
  if (!normalized && !isCursorObject) {
    return {
      success: false,
      error:
        "Unsupported format. Use { \"mcpServers\": { ... } } (Cursor format) or { \"servers\": [ ... ] }.",
    };
  }

  const servers = normalized?.servers ?? [];
  for (const server of servers) {
    const idError = validateMcpServerId(server.id);
    if (idError) {
      return { success: false, error: `Invalid server id "${server.id}": ${idError}` };
    }

    if (server.transport === "http" && !server.url.trim()) {
      return { success: false, error: `HTTP server "${server.id}" requires a non-empty url.` };
    }
    if (server.transport === "stdio" && !server.command.trim()) {
      return {
        success: false,
        error: `STDIO server "${server.id}" requires a non-empty command.`,
      };
    }
  }

  const cursor = normalized ? toCursorMcpServersFile(normalized) : { mcpServers: {} };
  const content = JSON.stringify(cursor, null, 2);

  await ensureDir(getProjectMcpDir(projectId));
  const filePath = getProjectMcpServersPath(projectId);
  await fs.writeFile(filePath, content, "utf-8");

  return {
    success: true,
    filePath,
    content,
    servers,
  };
}

const SKILL_FILE = "SKILL.md";

/** Agent Skills spec: lowercase, numbers, hyphens; no leading/trailing/consecutive hyphens (e.g. pdf, pdf-parsing) */
const NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_MAX_SKILL_FILES = 600;
const GITHUB_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

interface ParsedGitHubSkillUrl {
  owner: string;
  repo: string;
  ref?: string;
  sourcePath: string;
}

interface GitHubContentItem {
  type: string;
  path: string;
  download_url: string | null;
  url?: string;
}

interface GitHubFileDescriptor {
  repoPath: string;
  downloadUrl: string | null;
  apiUrl: string | null;
}

interface DownloadedGitHubFile {
  relativePath: string;
  content: Buffer;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move legacy .meta skills/instructions to root skills/ when possible.
 * Keeps backward compatibility for existing projects.
 */
async function migrateLegacySkillsDir(projectId: string): Promise<void> {
  const skillsDir = getProjectSkillsDir(projectId);
  const legacyDirs = [getProjectLegacySkillsDir(projectId), getProjectLegacyInstructionsDir(projectId)];
  if (await dirExists(skillsDir)) return;

  for (const legacyDir of legacyDirs) {
    if (!(await dirExists(legacyDir))) continue;
    try {
      await fs.rename(legacyDir, skillsDir);
      return;
    } catch {
      // fallback below
    }

    try {
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.cp(legacyDir, skillsDir, { recursive: true });
      return;
    } catch {
      // Keep legacy dirs if migration fails; readers still check them.
    }
  }
}

async function getProjectSkillDirs(projectId: string): Promise<string[]> {
  await migrateLegacySkillsDir(projectId);

  const skillsDir = getProjectSkillsDir(projectId);
  const legacySkillsDir = getProjectLegacySkillsDir(projectId);
  const legacyInstructionsDir = getProjectLegacyInstructionsDir(projectId);
  const dirs: string[] = [];

  if (await dirExists(skillsDir)) dirs.push(skillsDir);
  if (await dirExists(legacySkillsDir)) dirs.push(legacySkillsDir);
  if (await dirExists(legacyInstructionsDir)) dirs.push(legacyInstructionsDir);
  if (dirs.length === 0) dirs.push(skillsDir);

  return dirs;
}

async function findProjectSkillDir(
  projectId: string,
  skillName: string
): Promise<string | null> {
  const dirs = await getProjectSkillDirs(projectId);
  for (const baseDir of dirs) {
    const skillDir = path.join(baseDir, skillName);
    if (await dirExists(skillDir)) return skillDir;
  }
  return null;
}

/** Validate skill name per Agent Skills spec. Returns error message or null if valid. */
export function validateSkillName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Skill name is required.";
  if (n.length > 64) return "Skill name must be at most 64 characters.";
  if (!NAME_REGEX.test(n)) return "Skill name must use only lowercase letters, numbers, and hyphens; cannot start or end with a hyphen or contain consecutive hyphens (e.g. pdf, pdf-parsing, my-skill).";
  return null;
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed };
  }
  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  const frontmatterBlock = endIdx >= 0 ? rest.slice(0, endIdx) : "";
  const body = endIdx >= 0 ? rest.slice(endIdx + 4).trim() : rest.trim();
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[match[1].toLowerCase()] = value;
    }
  }
  return { frontmatter, body };
}

/**
 * Load only skill metadata (name, description) for system prompt.
 * Keeps context small (~50–100 tokens per skill). Full instructions loaded via load_skill tool.
 * https://agentskills.io/integrate-skills
 */
export async function loadProjectSkillsMetadata(
  projectId: string
): Promise<ProjectSkillMetadata[]> {
  const baseDirs = await getProjectSkillDirs(projectId);
  const list: ProjectSkillMetadata[] = [];
  const seen = new Set<string>();

  for (const baseDir of baseDirs) {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const key = entry.name.toLowerCase();
        if (seen.has(key)) continue;

        const skillDir = path.join(baseDir, entry.name);
        const skillFilePath = path.join(skillDir, SKILL_FILE);
        let content: string;
        try {
          content = await fs.readFile(skillFilePath, "utf-8");
        } catch {
          continue;
        }

        const { frontmatter } = parseFrontmatter(content);
        const dirNameLower = entry.name.toLowerCase();
        if (entry.name.length > 64 || !NAME_REGEX.test(dirNameLower) || dirNameLower.includes("--")) continue;
        const name = (frontmatter.name ?? entry.name).trim().toLowerCase();
        const description = (frontmatter.description ?? "").trim().slice(0, 1024);
        if (!name || !description) continue;
        if (name !== dirNameLower) continue;

        seen.add(key);
        list.push({ name: entry.name, description, skillDir });
      }
    } catch {
      // directory missing or not readable
    }
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a new skill in the project (Agent Skills spec).
 * Validates name and description; writes skills/<name>/SKILL.md.
 * Fails if a skill with that name already exists.
 */
export async function createSkill(
  projectId: string,
  params: {
    skill_name: string;
    description: string;
    body: string;
    compatibility?: string;
    license?: string;
  }
): Promise<{ success: true; skillDir: string } | { success: false; error: string }> {
  const name = params.skill_name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  const err = validateSkillName(name);
  if (err) return { success: false, error: err };

  const description = params.description.trim().slice(0, 1024);
  if (!description) return { success: false, error: "Description is required (1–1024 characters)." };

  await migrateLegacySkillsDir(projectId);
  const baseDir = getProjectSkillsDir(projectId);
  await ensureDir(baseDir);
  const existingSkillDir = await findProjectSkillDir(projectId, name);
  if (existingSkillDir) {
    return { success: false, error: `Skill "${name}" already exists. Choose a different name or delete the existing skill first.` };
  }
  const skillDir = path.join(baseDir, name);

  const body = (params.body ?? "").trim();
  const licenseLine = params.license?.trim() ? `license: ${escapeYamlValue(params.license.trim())}\n` : "";
  const compatibilityLine = params.compatibility?.trim() ? `compatibility: ${escapeYamlValue(params.compatibility.trim().slice(0, 500))}\n` : "";
  const frontmatter = `---
name: ${name}
description: ${escapeYamlValue(description)}
${licenseLine}${compatibilityLine}---`;

  const content = body ? `${frontmatter}\n\n${body}` : `${frontmatter}\n`;

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, SKILL_FILE), content, "utf-8");

  return { success: true, skillDir };
}

function escapeYamlValue(s: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9 -]*$/.test(s) && !s.includes(":") && !s.includes("\n")) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function normalizePosixPath(input: string): string {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

function encodeGitHubPath(pathValue: string): string {
  return normalizePosixPath(pathValue)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseGitHubSkillUrl(rawUrl: string): { ok: true; value: ParsedGitHubSkillUrl } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "Invalid URL. Provide a full GitHub URL." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    return {
      ok: false,
      error: "Only github.com URLs are supported for skill import.",
    };
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (parts.length < 2) {
    return {
      ok: false,
      error: "GitHub URL must include owner and repository.",
    };
  }

  const owner = parts[0].trim();
  const repo = parts[1].replace(/\.git$/i, "").trim();
  if (!owner || !repo) {
    return {
      ok: false,
      error: "GitHub URL must include valid owner and repository names.",
    };
  }

  let ref: string | undefined;
  let sourcePath = "";

  if (parts.length >= 3) {
    const mode = parts[2];
    if (mode === "tree" || mode === "blob" || mode === "raw") {
      if (parts[3]) {
        ref = parts[3].trim();
      }
      if (parts.length > 4) {
        sourcePath = normalizePosixPath(parts.slice(4).join("/"));
      }
    }
  }

  return {
    ok: true,
    value: {
      owner,
      repo,
      ref,
      sourcePath,
    },
  };
}

function githubApiHeaders(accept = "application/vnd.github+json"): HeadersInit {
  return {
    Accept: accept,
    "User-Agent": "eggent-skill-installer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubJson(
  url: string
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubApiHeaders(),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Network error calling GitHub API.",
    };
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAt = response.headers.get("x-ratelimit-reset");
    if (response.status === 403 && remaining === "0") {
      const reset = resetAt
        ? new Date(Number(resetAt) * 1000).toISOString()
        : "later";
      return {
        ok: false,
        status: response.status,
        error: `GitHub API rate limit exceeded. Try again after ${reset}.`,
      };
    }
    return {
      ok: false,
      status: response.status,
      error:
        payload?.message?.trim() ||
        `GitHub API request failed with status ${response.status}.`,
    };
  }

  const data = await response.json().catch(() => null);
  if (data === null) {
    return {
      ok: false,
      status: response.status,
      error: "GitHub API returned invalid JSON.",
    };
  }
  return { ok: true, data };
}

function asGitHubContentItem(value: unknown): GitHubContentItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : "";
  const filePath = typeof entry.path === "string" ? entry.path : "";
  if (!type || !filePath) return null;
  const downloadUrl = typeof entry.download_url === "string" ? entry.download_url : null;
  const apiUrl = typeof entry.url === "string" ? entry.url : null;
  return {
    type,
    path: normalizePosixPath(filePath),
    download_url: downloadUrl,
    url: apiUrl ?? undefined,
  };
}

async function resolveGitHubRef(
  owner: string,
  repo: string,
  ref: string | undefined
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const trimmedRef = ref?.trim();
  if (trimmedRef) {
    return { ok: true, ref: trimmedRef };
  }

  const repoMeta = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  );
  if (!repoMeta.ok) {
    return {
      ok: false,
      error: `Failed to resolve repository default branch: ${repoMeta.error}`,
    };
  }

  const defaultBranch =
    typeof (repoMeta.data as { default_branch?: unknown }).default_branch === "string"
      ? (repoMeta.data as { default_branch: string }).default_branch.trim()
      : "";
  if (!defaultBranch) {
    return {
      ok: false,
      error: "Failed to resolve repository default branch.",
    };
  }
  return { ok: true, ref: defaultBranch };
}

async function collectGitHubFiles(
  owner: string,
  repo: string,
  ref: string,
  sourcePath: string
): Promise<{ ok: true; files: GitHubFileDescriptor[] } | { ok: false; error: string }> {
  const queue: string[] = [sourcePath];
  const visitedDirs = new Set<string>();
  const files: GitHubFileDescriptor[] = [];

  while (queue.length > 0) {
    const current = normalizePosixPath(queue.shift() ?? "");
    if (visitedDirs.has(current)) continue;
    visitedDirs.add(current);

    const encoded = encodeGitHubPath(current);
    const endpoint =
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents` +
      `${encoded ? `/${encoded}` : ""}?ref=${encodeURIComponent(ref)}`;
    const result = await fetchGitHubJson(endpoint);
    if (!result.ok) {
      return {
        ok: false,
        error:
          current
            ? `Failed to read GitHub path "${current}": ${result.error}`
            : `Failed to read repository root: ${result.error}`,
      };
    }

    const list = Array.isArray(result.data) ? result.data : [result.data];
    for (const item of list) {
      const entry = asGitHubContentItem(item);
      if (!entry) continue;
      if (entry.type === "dir") {
        queue.push(entry.path);
        continue;
      }
      if (entry.type !== "file") continue;

      files.push({
        repoPath: entry.path,
        downloadUrl: entry.download_url,
        apiUrl: entry.url ?? null,
      });
      if (files.length > GITHUB_MAX_SKILL_FILES) {
        return {
          ok: false,
          error: `Skill import aborted: too many files (${files.length}). Maximum allowed is ${GITHUB_MAX_SKILL_FILES}.`,
        };
      }
    }
  }

  return { ok: true, files };
}

function deriveRelativeSkillPath(repoPath: string, sourcePath: string): string | null {
  const normalizedRepoPath = normalizePosixPath(repoPath);
  const normalizedSourcePath = normalizePosixPath(sourcePath);

  if (!normalizedSourcePath) {
    return normalizedRepoPath;
  }
  if (normalizedRepoPath === normalizedSourcePath) {
    return path.posix.basename(normalizedRepoPath);
  }
  const prefix = `${normalizedSourcePath}/`;
  if (!normalizedRepoPath.startsWith(prefix)) {
    return null;
  }
  return normalizedRepoPath.slice(prefix.length);
}

async function downloadGitHubFile(
  file: GitHubFileDescriptor
): Promise<{ ok: true; content: Buffer } | { ok: false; error: string }> {
  const targetUrl = file.downloadUrl ?? file.apiUrl;
  if (!targetUrl) {
    return {
      ok: false,
      error: `Cannot download "${file.repoPath}": missing download URL.`,
    };
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      headers: file.downloadUrl
        ? { "User-Agent": "eggent-skill-installer" }
        : githubApiHeaders("application/vnd.github.raw"),
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Failed to download "${file.repoPath}": ${error.message}`
          : `Failed to download "${file.repoPath}".`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Failed to download "${file.repoPath}" (status ${response.status}).`,
    };
  }

  const content = Buffer.from(await response.arrayBuffer());
  return { ok: true, content };
}

function sanitizeSkillNameCandidate(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function deriveSkillNameCandidate(repo: string, sourcePath: string): string {
  const normalizedSourcePath = normalizePosixPath(sourcePath);
  if (!normalizedSourcePath) return repo;

  const baseName = path.posix.basename(normalizedSourcePath);
  if (baseName.toLowerCase() !== "skill.md") {
    return baseName || repo;
  }

  const parent = path.posix.basename(path.posix.dirname(normalizedSourcePath));
  return parent || repo;
}

function upsertSkillFrontmatterName(raw: string, skillName: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.trimStart().startsWith("---")) {
    return normalized;
  }

  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return normalized;
  }
  const frontmatterBlock = match[1];
  const lines = frontmatterBlock.split("\n");
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^name:\s*/i.test(line)) {
      replaced = true;
      return `name: ${skillName}`;
    }
    return line;
  });

  if (!replaced) {
    nextLines.unshift(`name: ${skillName}`);
  }

  return normalized.replace(
    /^---\n[\s\S]*?\n---/,
    `---\n${nextLines.join("\n")}\n---`
  );
}

export async function installSkillFromGitHub(
  projectId: string,
  params: { url: string; skill_name?: string }
): Promise<
  | {
      success: true;
      skillDir: string;
      skillName: string;
      filesCopied: number;
      sourceRef: string;
      sourcePath: string;
    }
  | { success: false; error: string }
> {
  const rawUrl = params.url?.trim() ?? "";
  if (!rawUrl) {
    return { success: false, error: "GitHub URL is required." };
  }

  const project = await getProject(projectId);
  if (!project) {
    return { success: false, error: "Project not found." };
  }

  const parsedUrl = parseGitHubSkillUrl(rawUrl);
  if (!parsedUrl.ok) {
    return { success: false, error: parsedUrl.error };
  }

  const { owner, repo, sourcePath } = parsedUrl.value;
  const resolvedRef = await resolveGitHubRef(owner, repo, parsedUrl.value.ref);
  if (!resolvedRef.ok) {
    return { success: false, error: resolvedRef.error };
  }

  const ref = resolvedRef.ref;
  const collected = await collectGitHubFiles(owner, repo, ref, sourcePath);
  if (!collected.ok) {
    return { success: false, error: collected.error };
  }

  if (collected.files.length === 0) {
    return {
      success: false,
      error: sourcePath
        ? `No files found at path "${sourcePath}" for ref "${ref}".`
        : "Repository contains no files.",
    };
  }

  const downloaded: DownloadedGitHubFile[] = [];
  let totalBytes = 0;

  for (const file of collected.files) {
    const relativePath = deriveRelativeSkillPath(file.repoPath, sourcePath);
    if (!relativePath) continue;
    const normalizedRelativePath = normalizePosixPath(relativePath);
    if (
      !normalizedRelativePath ||
      normalizedRelativePath === ".." ||
      normalizedRelativePath.startsWith("../") ||
      normalizedRelativePath.includes("/../")
    ) {
      return {
        success: false,
        error: `Invalid relative path detected in repository: "${relativePath}".`,
      };
    }

    const fetched = await downloadGitHubFile(file);
    if (!fetched.ok) {
      return { success: false, error: fetched.error };
    }

    totalBytes += fetched.content.byteLength;
    if (totalBytes > GITHUB_MAX_TOTAL_BYTES) {
      return {
        success: false,
        error: `Skill import aborted: total file size exceeds ${Math.round(GITHUB_MAX_TOTAL_BYTES / (1024 * 1024))} MB.`,
      };
    }

    downloaded.push({
      relativePath: normalizedRelativePath,
      content: fetched.content,
    });
  }

  const skillMdIndex = downloaded.findIndex(
    (file) => file.relativePath.toLowerCase() === SKILL_FILE.toLowerCase()
  );
  if (skillMdIndex < 0) {
    return {
      success: false,
      error: `Imported path must contain ${SKILL_FILE} at its root.`,
    };
  }

  const explicitName = params.skill_name?.trim().toLowerCase();
  let skillName = explicitName ?? "";
  if (!skillName) {
    const parsedSkill = parseFrontmatter(downloaded[skillMdIndex].content.toString("utf-8"));
    const frontmatterName = (parsedSkill.frontmatter.name ?? "").trim().toLowerCase();
    if (frontmatterName && validateSkillName(frontmatterName) === null) {
      skillName = frontmatterName;
    } else {
      const candidate = deriveSkillNameCandidate(repo, sourcePath);
      skillName = sanitizeSkillNameCandidate(candidate);
    }
  }

  const nameError = validateSkillName(skillName);
  if (nameError) {
    return {
      success: false,
      error: `Failed to derive valid skill name "${skillName}": ${nameError}`,
    };
  }

  const existingSkillDir = await findProjectSkillDir(projectId, skillName);
  if (existingSkillDir) {
    return {
      success: false,
      error: `Skill "${skillName}" already exists. Choose another name or remove the existing skill first.`,
    };
  }

  const updatedSkillMd = upsertSkillFrontmatterName(
    downloaded[skillMdIndex].content.toString("utf-8"),
    skillName
  );
  downloaded[skillMdIndex] = {
    ...downloaded[skillMdIndex],
    content: Buffer.from(updatedSkillMd, "utf-8"),
  };

  await migrateLegacySkillsDir(projectId);
  const baseDir = getProjectSkillsDir(projectId);
  await ensureDir(baseDir);
  const targetDir = path.join(baseDir, skillName);
  const targetRoot = path.resolve(targetDir);

  try {
    await fs.mkdir(targetDir, { recursive: false });

    for (const file of downloaded) {
      const localRelative = file.relativePath.split("/").join(path.sep);
      const targetPath = path.resolve(targetDir, localRelative);
      if (!targetPath.startsWith(targetRoot + path.sep) && targetPath !== targetRoot) {
        throw new Error(`Invalid write path "${file.relativePath}".`);
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content);
    }
  } catch (error) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      success: false,
      error:
        error instanceof Error
          ? `Failed to write imported skill files: ${error.message}`
          : "Failed to write imported skill files.",
    };
  }

  return {
    success: true,
    skillDir: targetDir,
    skillName,
    filesCopied: downloaded.length,
    sourceRef: ref,
    sourcePath,
  };
}

/**
 * Write an optional file under a skill (scripts/, references/, assets/ or other).
 * Skill must already exist (SKILL.md present). Cannot overwrite SKILL.md.
 */
export async function writeSkillFile(
  projectId: string,
  skillName: string,
  relativePath: string,
  content: string
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) {
    return { success: false, error: `Skill "${skillName}" not found. Create the skill first with create_skill.` };
  }
  const skillFilePath = path.join(skillDir, SKILL_FILE);

  try {
    await fs.access(skillFilePath);
  } catch {
    return { success: false, error: `Skill "${skillName}" not found. Create the skill first with create_skill.` };
  }

  const normalized = path.normalize(relativePath).replace(/^[/\\]+/, "");
  if (normalized.includes("..")) {
    return { success: false, error: "Path must not contain '..'." };
  }
  const targetPath = path.join(skillDir, normalized);
  const skillDirReal = path.resolve(skillDir);
  const targetPathReal = path.resolve(targetPath);
  if (!targetPathReal.startsWith(skillDirReal + path.sep) && targetPathReal !== skillDirReal) {
    return { success: false, error: "Path must be inside the skill directory." };
  }
  if (path.resolve(skillDir, normalized) === path.resolve(skillDir, SKILL_FILE)) {
    return { success: false, error: "Cannot overwrite SKILL.md. Use create_skill or edit manually." };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf-8");
  return { success: true, filePath: targetPath };
}

/**
 * Update an existing skill's SKILL.md frontmatter/body.
 * Unspecified fields keep previous values. Set compatibility/license to null to remove.
 */
export async function updateSkill(
  projectId: string,
  params: {
    skill_name: string;
    description?: string;
    body?: string;
    compatibility?: string | null;
    license?: string | null;
  }
): Promise<{ success: true; skillFilePath: string } | { success: false; error: string }> {
  const skillName = params.skill_name.trim().toLowerCase();
  if (!skillName) return { success: false, error: "Skill name is required." };

  if (
    params.description === undefined &&
    params.body === undefined &&
    params.compatibility === undefined &&
    params.license === undefined
  ) {
    return {
      success: false,
      error: "Provide at least one field to update: description, body, compatibility, or license.",
    };
  }

  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) {
    return { success: false, error: `Skill "${skillName}" not found.` };
  }

  const skillFilePath = path.join(skillDir, SKILL_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(skillFilePath, "utf-8");
  } catch {
    return { success: false, error: `Skill "${skillName}" not found.` };
  }

  const { frontmatter, body: existingBody } = parseFrontmatter(raw);
  const existingDescription = (frontmatter.description ?? "").trim().slice(0, 1024);
  const existingCompatibility = frontmatter.compatibility?.trim();
  const existingLicense = frontmatter.license?.trim();

  let nextDescription = existingDescription;
  if (params.description !== undefined) {
    nextDescription = params.description.trim().slice(0, 1024);
    if (!nextDescription) {
      return { success: false, error: "Description is required (1–1024 characters)." };
    }
  }
  if (!nextDescription) {
    return { success: false, error: "Description is required (1–1024 characters)." };
  }

  const nextBody = (params.body ?? existingBody).trim();

  const compatibilityInput =
    params.compatibility === undefined ? existingCompatibility : params.compatibility;
  const compatibility =
    typeof compatibilityInput === "string"
      ? compatibilityInput.trim().slice(0, 500)
      : "";

  const licenseInput = params.license === undefined ? existingLicense : params.license;
  const license = typeof licenseInput === "string" ? licenseInput.trim() : "";

  const nameLine = `name: ${skillName}`;
  const descriptionLine = `description: ${escapeYamlValue(nextDescription)}`;
  const licenseLine = license ? `license: ${escapeYamlValue(license)}` : "";
  const compatibilityLine = compatibility
    ? `compatibility: ${escapeYamlValue(compatibility)}`
    : "";

  const frontmatterLines = [
    "---",
    nameLine,
    descriptionLine,
    ...(licenseLine ? [licenseLine] : []),
    ...(compatibilityLine ? [compatibilityLine] : []),
    "---",
  ];
  const nextContent = nextBody
    ? `${frontmatterLines.join("\n")}\n\n${nextBody}`
    : `${frontmatterLines.join("\n")}\n`;

  await fs.writeFile(skillFilePath, nextContent, "utf-8");
  return { success: true, skillFilePath };
}

export async function deleteSkill(
  projectId: string,
  skillName: string
): Promise<{ success: true; skillDir: string } | { success: false; error: string }> {
  const normalizedName = skillName.trim().toLowerCase();
  if (!normalizedName) return { success: false, error: "Skill name is required." };

  const skillDir = await findProjectSkillDir(projectId, normalizedName);
  if (!skillDir) {
    return { success: false, error: `Skill "${normalizedName}" not found.` };
  }

  try {
    await fs.rm(skillDir, { recursive: true, force: false });
    return { success: true, skillDir };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete skill.",
    };
  }
}

/**
 * Load full instructions for one skill (used when model activates a skill via load_skill tool).
 */
export async function loadSkillInstructions(
  projectId: string,
  skillName: string
): Promise<ProjectSkill | null> {
  const skillDir = await findProjectSkillDir(projectId, skillName);
  if (!skillDir) return null;
  const skillFilePath = path.join(skillDir, SKILL_FILE);
  try {
    const content = await fs.readFile(skillFilePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const name = (frontmatter.name ?? skillName).trim().toLowerCase();
    const description = (frontmatter.description ?? "").trim().slice(0, 1024);
    if (name !== skillName.toLowerCase()) return null;
    return {
      name: skillName,
      description,
      body: body.trim(),
      license: frontmatter.license?.trim() || undefined,
      compatibility: frontmatter.compatibility?.trim() || undefined,
      skillDir,
    };
  } catch {
    return null;
  }
}

/**
 * Load all skills (full body). Used when full list with bodies is needed.
 * For agent prompt prefer loadProjectSkillsMetadata + load_skill tool.
 */
export async function loadProjectSkills(
  projectId: string
): Promise<ProjectSkill[]> {
  const metaList = await loadProjectSkillsMetadata(projectId);
  const skills: ProjectSkill[] = [];
  for (const m of metaList) {
    const full = await loadSkillInstructions(projectId, m.name);
    if (full) skills.push(full);
  }
  return skills;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
}

function defaultProjectMemory(projectName: string): string {
  return [`# ${projectName} memory`, "", "Persistent notes for this project/pi agent.", ""].join("\n");
}

function defaultProjectModelFile(): string {
  return JSON.stringify({ inheritsGlobal: true }, null, 2);
}

function defaultProjectCronFile(): string {
  return JSON.stringify({ version: 1, jobs: [] }, null, 2);
}

async function ensureProjectDiskLayout(project: Project): Promise<Project> {
  const root = projectDir(project.id);
  await ensureDir(root);
  await ensureDir(getProjectSkillsDir(project.id));

  const legacyMcpPath = path.join(projectMetaDir(project.id), "mcp", "servers.json");
  const mcpPath = getProjectMcpServersPath(project.id);
  if (!(await readTextIfExists(mcpPath))) {
    const legacyMcp = await readTextIfExists(legacyMcpPath);
    await writeTextFile(mcpPath, legacyMcp ?? JSON.stringify({ mcpServers: {} }, null, 2));
  }

  const contextPath = getProjectContextPath(project.id);
  const context = await readTextIfExists(contextPath);
  if (context === null) {
    await writeTextFile(contextPath, project.instructions || `# ${project.name}\n\n`);
  }

  const memoryPath = getProjectMemoryPath(project.id);
  if ((await readTextIfExists(memoryPath)) === null) {
    await writeTextFile(memoryPath, defaultProjectMemory(project.name));
  }

  if ((await readTextIfExists(path.join(projectDir(project.id), PROJECT_CRON_FILENAME))) === null) {
    const legacyCron = await readTextIfExists(path.join(projectMetaDir(project.id), "cron", "jobs.json"));
    await writeTextFile(path.join(projectDir(project.id), PROJECT_CRON_FILENAME), legacyCron ?? defaultProjectCronFile());
  }

  if ((await readTextIfExists(getProjectModelSettingsPath(project.id))) === null) {
    await writeTextFile(getProjectModelSettingsPath(project.id), defaultProjectModelFile());
  }

  const currentContext = await readTextIfExists(contextPath);
  return {
    ...project,
    instructions: currentContext ?? project.instructions ?? "",
  };
}

export async function readProjectContext(projectId: string): Promise<string> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  return (await readTextIfExists(getProjectContextPath(projectId))) ?? project.instructions ?? "";
}

export async function saveProjectContext(projectId: string, content: string): Promise<Project | null> {
  const existing = await getProject(projectId);
  if (!existing) return null;
  await writeTextFile(getProjectContextPath(projectId), content);
  return updateProject(projectId, { instructions: content });
}

export async function readProjectMemoryFile(projectId: string): Promise<string> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  return (await readTextIfExists(getProjectMemoryPath(projectId))) ?? defaultProjectMemory(project.name);
}

export async function saveProjectMemoryFile(projectId: string, content: string): Promise<void> {
  await writeTextFile(getProjectMemoryPath(projectId), content);
  publishUiSyncEvent({ topic: "projects", projectId, reason: "project_memory_updated" });
}

export async function readProjectModelSettingsFile(projectId: string): Promise<string> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  return (await readTextIfExists(getProjectModelSettingsPath(projectId))) ?? defaultProjectModelFile();
}

export async function saveProjectModelSettingsFile(projectId: string, content: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim() ? content : defaultProjectModelFile());
  } catch {
    throw new Error("model.json must be valid JSON.");
  }
  const normalized = JSON.stringify(parsed, null, 2);
  await writeTextFile(getProjectModelSettingsPath(projectId), normalized);
  publishUiSyncEvent({ topic: "projects", projectId, reason: "project_model_updated" });
  return normalized;
}

export async function loadProjectModelSettings(projectId: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readProjectModelSettingsFile(projectId);
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function appendProjectMemory(projectId: string, text: string, area = "main"): Promise<void> {
  const existing = await readProjectMemoryFile(projectId);
  const entry = [
    "",
    `## ${area} — ${new Date().toISOString()}`,
    "",
    text.trim(),
    "",
  ].join("\n");
  await saveProjectMemoryFile(projectId, existing.replace(/\s*$/, "\n") + entry);
}

export async function searchProjectMemory(projectId: string, query: string, limit = 5): Promise<string> {
  const content = await readProjectMemoryFile(projectId);
  const q = query.trim().toLowerCase();
  if (!q) return content;
  const tokens = q.split(/\s+/).filter(Boolean);
  const blocks = content.split(/\n(?=##\s+)/g);
  const matches = blocks
    .map((block) => ({ block, score: tokens.reduce((n, t) => n + (block.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((item) => item.block.trim());
  return matches.length > 0 ? matches.join("\n\n---\n\n") : "No matching project memory entries.";
}

export async function deleteProjectMemoryMatches(projectId: string, query: string): Promise<string> {
  const content = await readProjectMemoryFile(projectId);
  const q = query.trim().toLowerCase();
  if (!q) return "Query is required.";
  const blocks = content.split(/\n(?=##\s+)/g);
  const kept = blocks.filter((block) => !block.toLowerCase().includes(q));
  const removed = blocks.length - kept.length;
  if (removed > 0) await saveProjectMemoryFile(projectId, kept.join("\n"));
  return `Removed ${removed} matching memory block(s).`;
}

export async function getAllProjects(): Promise<Project[]> {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metaFile = projectMetaFile(entry.name);
      let content = await readTextIfExists(metaFile);
      if (content === null) {
        const legacyContent = await readTextIfExists(legacyProjectMetaFile(entry.name));
        if (legacyContent !== null) {
          content = legacyContent;
          await writeTextFile(metaFile, legacyContent);
        }
      }
      if (content === null) continue;
      projects.push(await ensureProjectDiskLayout(JSON.parse(content)));
    } catch {
      // skip projects without metadata
    }
  }

  return projects.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getProject(projectId: string): Promise<Project | null> {
  try {
    let content = await readTextIfExists(projectMetaFile(projectId));
    if (content === null) {
      const legacyContent = await readTextIfExists(legacyProjectMetaFile(projectId));
      if (legacyContent !== null) {
        content = legacyContent;
        await writeTextFile(projectMetaFile(projectId), legacyContent);
      }
    }
    if (content === null) return null;
    return ensureProjectDiskLayout(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function createProject(
  project: Omit<Project, "createdAt" | "updatedAt">
): Promise<Project> {
  const now = new Date().toISOString();
  const fullProject: Project = {
    ...project,
    createdAt: now,
    updatedAt: now,
  };

  const projectRoot = path.join(PROJECTS_DIR, project.id);
  await ensureDir(projectRoot);
  await ensureDir(getProjectSkillsDir(project.id));

  await writeTextFile(getProjectContextPath(project.id), project.instructions || `# ${project.name}\n\n`);
  await writeTextFile(getProjectMemoryPath(project.id), defaultProjectMemory(project.name));
  await writeTextFile(getProjectMcpServersPath(project.id), JSON.stringify({ mcpServers: {} }, null, 2));
  await writeTextFile(path.join(projectRoot, PROJECT_CRON_FILENAME), defaultProjectCronFile());
  await writeTextFile(getProjectModelSettingsPath(project.id), defaultProjectModelFile());
  await writeTextFile(projectMetaFile(project.id), JSON.stringify(fullProject, null, 2));

  publishUiSyncEvent({
    topic: "projects",
    projectId: project.id,
    reason: "project_created",
  });

  return fullProject;
}

export async function updateProject(
  projectId: string,
  updates: Partial<Project>
): Promise<Project | null> {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const updated: Project = {
    ...existing,
    ...updates,
    id: existing.id, // don't allow ID change
    updatedAt: new Date().toISOString(),
  };

  await writeTextFile(projectMetaFile(projectId), JSON.stringify(updated, null, 2));
  if (updates.instructions !== undefined) {
    await writeTextFile(getProjectContextPath(projectId), updates.instructions || "");
  }

  publishUiSyncEvent({
    topic: "projects",
    projectId,
    reason: "project_updated",
  });

  return updated;
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  try {
    // Remove chats that belong to this project
    await deleteChatsByProjectId(projectId);
    // Remove project's vector memory (dir and in-memory cache)
    const memoryDir = path.join(DATA_DIR, "memory", projectId);
    await fs.rm(memoryDir, { recursive: true, force: true });
    clearMemoryCache(projectId);
    // Remove project directory (config files, skills, user files, legacy .meta, etc.)
    await fs.rm(projectDir, { recursive: true, force: true });
    publishUiSyncEvent({
      topic: "projects",
      projectId,
      reason: "project_deleted",
    });
    return true;
  } catch {
    return false;
  }
}

export async function getProjectFiles(
  projectId: string,
  subPath: string = ""
): Promise<{ name: string; type: "file" | "directory"; size: number }[]> {
  const baseDir = getWorkDir(projectId);
  const targetDir = subPath
    ? path.join(baseDir, subPath)
    : baseDir;

  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const files = [];
    const HIDDEN_NAMES = new Set([".meta", ".cron-runs", ".venv", "venv", PROJECT_METADATA_FILENAME]);

    for (const entry of entries) {
      if (HIDDEN_NAMES.has(entry.name)) continue; // hide internal metadata and virtualenvs
      const stat = await fs.stat(path.join(targetDir, entry.name));
      files.push({
        name: entry.name,
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        size: stat.size,
      });
    }

    return files.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

export function getProjectWorkDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId);
}

export { PROJECTS_DIR };
