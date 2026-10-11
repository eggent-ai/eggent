import fs from "node:fs/promises";
import path from "node:path";
import { getWorkDir, isHiddenFileName } from "@/lib/storage/project-store";
import { fileMentionPath } from "@/lib/files/openable";
import { isSecretFileName } from "@/lib/files/zip-walk";

/**
 * The files a turn made, for the row under its answer.
 *
 * Someone who asks for a document gets a path in the answer and has to go and
 * find it. This finds what the turn produced - the files the answer names and
 * the files its tools wrote - so the answer can carry them, with a button.
 *
 * Precision before recall: a card that lists a file the agent did not make
 * teaches people to ignore the card. So a file counts only if it is inside the
 * folder the turn works in, is a plain file that was written during this turn,
 * and is not the agent's own housekeeping (its notes, its skills, its tools).
 * What the answer names comes first, then what a tool wrote. A scan of the
 * folder for new files is the last resort, used only when the turn ran
 * commands and nothing else pointed at a result.
 */

export type ProducedSource = "answer" | "tool" | "scan";

export interface ProducedFile {
  /** Relative to the folder it belongs to, forward slashes. */
  path: string;
  size: number;
  source: ProducedSource;
}

/** The files of one folder: a project's, or the orchestrator's ("none"). */
export interface ProducedGroup {
  project: string;
  items: ProducedFile[];
  /** How many there were; `items` holds the first few. */
  total: number;
}

/** What is kept with a message: up to this many files, the rest only counted. */
export const MAX_STORED_FILES = 12;
const MAX_SCAN_ENTRIES = 5000;
const MAX_SCAN_DEPTH = 6;
// A file written in the same second the turn began still counts.
const START_SLACK_MS = 2000;

/** Top-level files and folders that are the agent's own housekeeping, not something it made for the person. */
const INTERNAL_TOP_LEVEL = new Set([
  "memory.md", "context.md", "learned.md", ".mcp.json", "mcp.json", "model.json", "project.json",
  "skills", ".pi", "tools", ".eggent-tools", "uploads",
]);
const SKIPPED_SEGMENTS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".cache", ".next", ".pi"]);
const SCAN_TOOLS = new Set(["bash", "execute_code", "powershell", "mcp", "agent"]);

interface ToolLike {
  toolName: string;
  input?: unknown;
  output?: unknown;
  status?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Paths an answer names: in code, in bold and as link targets - the same places a path is turned into a link. */
export function pathsNamedIn(text: string): string[] {
  const found: string[] = [];
  const consider = (value: string) => {
    const mention = fileMentionPath(value);
    if (mention && !found.includes(mention)) found.push(mention);
  };
  for (const match of text.matchAll(/`([^`\n]{1,200})`/g)) consider(match[1]);
  for (const match of text.matchAll(/\*\*([^*\n]{1,200})\*\*/g)) consider(match[1]);
  for (const match of text.matchAll(/\]\(([^)\s]{1,300})\)/g)) consider(safeDecode(match[1]));
  return found;
}

/** The images a generation tool saved, from its result. */
function imagePathsOf(output: unknown): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          walk(JSON.parse(trimmed), depth + 1);
        } catch {
          // Not JSON: nothing to read a path from.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (Array.isArray(record.images)) {
      for (const image of record.images) {
        const imagePath = asRecord(image)?.path;
        if (typeof imagePath === "string") paths.push(imagePath);
      }
    }
    walk(record.details, depth + 1);
    walk(record.content, depth + 1);
    if (typeof record.text === "string") walk(record.text, depth + 1);
  };
  walk(output, 0);
  return paths;
}

function isInternal(relative: string): boolean {
  const segments = relative.split("/");
  if (INTERNAL_TOP_LEVEL.has(segments[0].toLowerCase())) return true;
  return segments.some((segment) => SKIPPED_SEGMENTS.has(segment) || isHiddenFileName(segment) || segment === ".DS_Store");
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

export interface CollectInput {
  tools: Iterable<ToolLike>;
  /** When the turn began, in milliseconds. */
  startedAt: number;
  /** The session's working directory: where a relative path is relative to. */
  cwd: string;
  projectId?: string | null;
  assistantText: string;
}

export async function collectProducedFiles(input: CollectInput): Promise<ProducedGroup | null> {
  const projectKey = input.projectId && input.projectId !== "none" ? input.projectId : "none";
  const workDir = await realpathOrNull(path.resolve(getWorkDir(projectKey)));
  const cwd = await realpathOrNull(path.resolve(input.cwd));
  if (!workDir || !cwd) return null;

  const tools = [...input.tools];
  const ordered: Array<{ absolute: string; source: ProducedSource }> = [];
  const add = (candidate: string, source: ProducedSource) => {
    if (!ordered.some((entry) => entry.absolute === candidate)) ordered.push({ absolute: candidate, source });
  };

  // An answer writes a path from where its author stands, which is the project's
  // folder as often as the session's working directory: try both.
  for (const mention of pathsNamedIn(input.assistantText)) {
    add(path.resolve(cwd, mention), "answer");
    add(path.resolve(workDir, mention), "answer");
  }
  const named = new Set(ordered.map((entry) => entry.absolute));

  for (const tool of tools) {
    if (tool.status && tool.status !== "completed") continue;
    const name = tool.toolName.toLowerCase();
    const args = asRecord(tool.input);
    if (name === "write") {
      const target = args?.path ?? args?.file_path;
      if (typeof target === "string") add(path.resolve(cwd, target), "tool");
    } else if (name === "edit") {
      // Editing is touching what was there; it is a result only if the answer says so.
      const target = args?.path ?? args?.file_path;
      if (typeof target === "string" && named.has(path.resolve(cwd, target))) add(path.resolve(cwd, target), "tool");
    } else if (name === "eggent_generate_image") {
      for (const imagePath of imagePathsOf(tool.output)) add(path.resolve(cwd, imagePath), "tool");
    }
  }

  const accepted: ProducedFile[] = [];
  const accept = async (absolute: string, source: ProducedSource) => {
    // Only metadata is read here, so a path that names somewhere else costs nothing; what it
    // resolves to has to be inside the folder, whatever links lie on the way.
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      return;
    }
    // A link is not a file the turn made, and neither is a folder.
    if (!stat.isFile()) return;
    const real = await realpathOrNull(absolute);
    if (!real || !real.startsWith(workDir + path.sep)) return;
    const relative = path.relative(workDir, real).split(path.sep).join("/");
    if (!relative || isInternal(relative) || isSecretFileName(path.basename(relative))) return;
    if (stat.mtimeMs < input.startedAt - START_SLACK_MS) return;
    accepted.push({ path: relative, size: stat.size, source });
  };

  for (const entry of ordered) await accept(entry.absolute, entry.source);

  // The last resort: the turn ran commands and nothing named a result.
  if (accepted.length === 0 && tools.some((tool) => SCAN_TOOLS.has(tool.toolName.toLowerCase()))) {
    const found: Array<{ absolute: string }> = [];
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (visited >= MAX_SCAN_ENTRIES) return;
        visited += 1;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_SEGMENTS.has(entry.name) || isHiddenFileName(entry.name)) continue;
          if (directory === cwd && INTERNAL_TOP_LEVEL.has(entry.name.toLowerCase())) continue;
          await walk(absolute, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.lstat(absolute);
            // Born during the turn where the filesystem says so; modified during it where it does not.
            const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
            if (born >= input.startedAt - START_SLACK_MS) found.push({ absolute });
          } catch {
            // Gone already.
          }
        }
      }
    };
    await walk(cwd, 0);
    // In name order: a set of pages or chapters reads in the order it was numbered.
    found.sort((a, b) => (a.absolute < b.absolute ? -1 : a.absolute > b.absolute ? 1 : 0));
    for (const entry of found) await accept(entry.absolute, "scan");
  }

  if (accepted.length === 0) return null;
  return {
    project: projectKey,
    items: accepted.slice(0, MAX_STORED_FILES),
    total: accepted.length,
  };
}

/** Folds the files a visit made into what the asking turn made, keeping each folder's files together. */
export function mergeProducedGroups(groups: ReadonlyArray<ProducedGroup | null | undefined>): ProducedGroup[] {
  const merged = new Map<string, ProducedGroup>();
  for (const group of groups) {
    if (!group || group.items.length === 0) continue;
    const existing = merged.get(group.project);
    if (!existing) {
      merged.set(group.project, { project: group.project, items: [...group.items], total: group.total });
      continue;
    }
    for (const item of group.items) {
      if (!existing.items.some((known) => known.path === item.path)) {
        existing.items.push(item);
        existing.total += 1;
      }
    }
    existing.items = existing.items.slice(0, MAX_STORED_FILES);
  }
  return [...merged.values()];
}
