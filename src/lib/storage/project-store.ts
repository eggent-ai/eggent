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

function projectMetaDir(projectId: string) {
  return path.join(PROJECTS_DIR, projectId, ".meta");
}

function projectMetaFile(projectId: string) {
  return path.join(projectMetaDir(projectId), "project.json");
}

/** Path to project's .meta/skills directory — Agent Skills spec */
export function getProjectSkillsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "skills");
}

/** Legacy path to project's .meta/instructions directory (kept for compatibility/migration). */
function getProjectLegacyInstructionsDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "instructions");
}

/** @deprecated Use getProjectSkillsDir. Kept for compatibility with existing imports. */
export function getProjectInstructionsDir(projectId: string): string {
  return getProjectSkillsDir(projectId);
}

/** Path to project's .meta/mcp directory — MCP servers config (next to skills) */
export function getProjectMcpDir(projectId: string): string {
  return path.join(projectMetaDir(projectId), "mcp");
}

/** Path to project's .meta/mcp/servers.json */
export function getProjectMcpServersPath(projectId: string): string {
  return path.join(getProjectMcpDir(projectId), "servers.json");
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

const SKILL_FILE = "SKILL.md";

/** Agent Skills spec: lowercase, numbers, hyphens; no leading/trailing/consecutive hyphens (e.g. pdf, pdf-parsing) */
const NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move legacy .meta/instructions to .meta/skills when possible.
 * Keeps backward compatibility for existing projects.
 */
async function migrateLegacySkillsDir(projectId: string): Promise<void> {
  const skillsDir = getProjectSkillsDir(projectId);
  const legacyDir = getProjectLegacyInstructionsDir(projectId);
  const [skillsExists, legacyExists] = await Promise.all([
    dirExists(skillsDir),
    dirExists(legacyDir),
  ]);

  if (skillsExists || !legacyExists) return;

  try {
    await fs.rename(legacyDir, skillsDir);
    return;
  } catch {
    // fallback below
  }

  try {
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.cp(legacyDir, skillsDir, { recursive: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  } catch {
    // Keep both dirs if migration fails; readers still check legacy path.
  }
}

async function getProjectSkillDirs(projectId: string): Promise<string[]> {
  await migrateLegacySkillsDir(projectId);

  const skillsDir = getProjectSkillsDir(projectId);
  const legacyDir = getProjectLegacyInstructionsDir(projectId);
  const dirs: string[] = [];

  if (await dirExists(skillsDir)) dirs.push(skillsDir);
  if (await dirExists(legacyDir)) dirs.push(legacyDir);
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
 * Validates name and description; writes .meta/skills/<name>/SKILL.md.
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

export async function getAllProjects(): Promise<Project[]> {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metaFile = projectMetaFile(entry.name);
      const content = await fs.readFile(metaFile, "utf-8");
      projects.push(JSON.parse(content));
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
    const content = await fs.readFile(projectMetaFile(projectId), "utf-8");
    return JSON.parse(content);
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

  const projectDir = path.join(PROJECTS_DIR, project.id);
  await ensureDir(projectDir);
  await ensureDir(projectMetaDir(project.id));
  await ensureDir(getProjectSkillsDir(project.id));
  await ensureDir(path.join(projectMetaDir(project.id), "knowledge"));
  await ensureDir(getProjectMcpDir(project.id));

  const defaultMcpServers = {
    mcpServers: {
      "firecrawl-mcp": {
        command: "npx",
        args: ["-y", "firecrawl-mcp"],
        env: {
          FIRECRAWL_API_KEY: "",
        },
      },
      "sendforsign-mcp": {
        command: "npx",
        args: ["-y", "@sendforsign/mcp"],
        env: {
          EGGENT_API_KEY: "",
          EGGENT_CLIENT_KEY: "",
        },
      },
    },
  };

  await fs.writeFile(
    getProjectMcpServersPath(project.id),
    JSON.stringify(defaultMcpServers, null, 2),
    "utf-8"
  );

  await fs.writeFile(
    projectMetaFile(project.id),
    JSON.stringify(fullProject, null, 2),
    "utf-8"
  );

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

  await fs.writeFile(
    projectMetaFile(projectId),
    JSON.stringify(updated, null, 2),
    "utf-8"
  );

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
    // Remove project directory (files, .meta, etc.)
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

    for (const entry of entries) {
      if (entry.name === ".meta") continue; // hide metadata
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
