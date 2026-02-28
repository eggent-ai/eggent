import fs from "fs/promises";
import path from "path";
import {
  getProject,
  loadProjectSkillsMetadata,
  getProjectFiles,
  getWorkDir,
} from "@/lib/storage/project-store";
import { getChatFiles } from "@/lib/storage/chat-files-store";

const PROMPTS_DIR = path.join(process.cwd(), "src", "prompts");

/**
 * Load a prompt template from the prompts directory
 */
async function loadPrompt(name: string): Promise<string> {
  try {
    const filePath = path.join(PROMPTS_DIR, `${name}.md`);
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Recursively get all files from a directory with full paths
 */
async function getAllProjectFilesRecursive(
  projectId: string,
  subPath: string = ""
): Promise<{ name: string; path: string; size: number }[]> {
  const baseDir = getWorkDir(projectId);
  const files = await getProjectFiles(projectId, subPath);
  const result: { name: string; path: string; size: number }[] = [];

  for (const file of files) {
    const relativePath = subPath ? `${subPath}/${file.name}` : file.name;
    const fullPath = path.join(baseDir, relativePath);

    if (file.type === "file") {
      result.push({
        name: file.name,
        path: fullPath,
        size: file.size,
      });
    } else if (file.type === "directory") {
      // Recursively get files from subdirectories
      const subFiles = await getAllProjectFilesRecursive(projectId, relativePath);
      result.push(...subFiles);
    }
  }

  return result;
}

/**
 * Build the complete system prompt for the agent
 */
export async function buildSystemPrompt(options: {
  projectId?: string;
  chatId?: string;
  agentNumber?: number;
  tools?: string[];
}): Promise<string> {
  const parts: string[] = [];

  // 1. Base system prompt
  const basePrompt = await loadPrompt("system");
  if (basePrompt) {
    parts.push(basePrompt);
  } else {
    parts.push(getDefaultSystemPrompt());
  }

  // 2. Agent identity
  const agentNum = options.agentNumber ?? 0;
  parts.push(
    `\n## Agent Identity\nYou are AI Agent` +
    (agentNum === 0
      ? "You are the primary agent communicating directly with the user."
      : `You are a subordinate agent (level ${agentNum}), delegated a task by Agent ${agentNum - 1}.`)
  );

  // 3. Compact tool usage rules (detailed descriptions are already in tool schemas)
  if (options.tools && options.tools.length > 0) {
    const mcpToolNames = options.tools.filter((t) => t.startsWith("mcp_"));
    if (mcpToolNames.length > 0) {
      parts.push(
        `\n## MCP Tools\n` +
        `${mcpToolNames.length} MCP tool(s) available (prefixed \`mcp_<server>_<tool>\`). ` +
        `After an error, change the payload before retrying.`
      );
    }

    parts.push(
      `\n## Tool Rules\n` +
      `- Never repeat a failed tool call with identical arguments; read the error and adjust.\n` +
      `- After two corrected attempts still fail, report the blocker to the user.`
    );
  }

  // 4. Project instructions and Skills
  if (options.projectId) {
    const project = await getProject(options.projectId);
    if (project) {
      parts.push(
        `\n## Active Project: ${project.name}\n` +
        `Description: ${project.description}\n` +
        (project.instructions
          ? `\n### Project Instructions\n${project.instructions}`
          : "")
      );

      // 4b. Project Skills — compact list; full instructions loaded via load_skill tool
      const skillsMeta = await loadProjectSkillsMetadata(options.projectId);
      if (skillsMeta.length > 0) {
        const list = skillsMeta.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
        parts.push(
          `\n## Skills\nWhen a task matches a skill, call **load_skill** with its name.\n${list}`
        );
      }
    }
  }

  // 5. Available Files — compact list (paths only)
  if (options.projectId || options.chatId) {
    const filePaths: string[] = [];

    if (options.projectId) {
      try {
        const projectFiles = await getAllProjectFilesRecursive(options.projectId);
        filePaths.push(...projectFiles.slice(0, 30).map((f) => f.path));
        if (projectFiles.length > 30) {
          filePaths.push(`... and ${projectFiles.length - 30} more`);
        }
      } catch { /* ignore */ }
    }

    if (options.chatId) {
      try {
        const chatFiles = await getChatFiles(options.chatId);
        filePaths.push(...chatFiles.map((f) => f.path));
      } catch { /* ignore */ }
    }

    if (filePaths.length > 0) {
      parts.push(`\n## Files\n${filePaths.join("\n")}`);
    }
  }

  // 6. Current date/time
  parts.push(
    `\n## Current Information\n- Date/Time: ${new Date().toISOString()}\n- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
  );

  return parts.join("\n\n");
}

function getDefaultSystemPrompt(): string {
  return `# Eggent Agent

You are a helpful AI assistant with tool access (code execution, memory, web search, file I/O, cron, multi-agent delegation).

## Rules
- Answer simple questions directly with text — no tool calls needed.
- Use tools only when the task genuinely requires them.
- Do NOT use code_execution for questions you can answer from knowledge.
- Never fabricate information — search or say you don't know.
- Be direct, concise, use markdown formatting.`;
}
