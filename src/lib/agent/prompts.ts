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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

  // 3. Tool prompts
  if (options.tools && options.tools.length > 0) {
    const mcpToolNames = options.tools.filter((t) => t.startsWith("mcp_"));
    for (const toolName of options.tools) {
      const toolPrompt = await loadPrompt(`tool-${toolName}`);
      if (toolPrompt) {
        parts.push(`\n## Tool: ${toolName}\n${toolPrompt}`);
      }
    }
    if (mcpToolNames.length > 0) {
      parts.push(
        `\n## MCP (Model Context Protocol) tools\n` +
        `This project has ${mcpToolNames.length} tool(s) from connected MCP servers. ` +
        `Tool names are prefixed with \`mcp_<server>_<tool>\`. Use them when the task matches their description.\n\n` +
        `MCP execution rules:\n` +
        `- After an error, do not repeat the same MCP tool call with identical arguments.\n` +
        `- Read error details and change the payload before retrying.\n` +
        `- For n8n workflow updates, use a real workflow id from a successful tool response; never guess ids.`
      );
    }

    parts.push(
      `\n## Tool Loop Safety\n` +
      `- After a failed tool call, do not repeat the same tool with identical arguments.\n` +
      `- Use the tool's error details to change parameters before retrying.\n` +
      `- For skill tools (load_skill/load_skill_resource/create_skill/update_skill/delete_skill/write_skill_file), use exact skill names and valid paths.\n` +
      `- If two corrected attempts still fail, report the blocker to the user instead of retrying endlessly.`
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

      // 4b. Project Skills — metadata only at startup; full instructions via load_skill tool (integrate-skills)
      const skillsMeta = await loadProjectSkillsMetadata(options.projectId);
      if (skillsMeta.length > 0) {
        parts.push(
          `\n## Project Skills (available)\n` +
          `This project has ${skillsMeta.length} skill(s). Match the user's task to a skill by description. When a task matches a skill, call the **load_skill** tool with that skill's name to load its full instructions, then follow them. Use only skills that apply.\n` +
          `<available_skills>\n` +
          skillsMeta
            .map(
              (s) =>
                `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n  </skill>`
            )
            .join("\n") +
          `\n</available_skills>`
        );
      }
    }
  }

  // 5. Available Files (Project Directory + Chat Uploaded)
  if (options.projectId || options.chatId) {
    const filesSections: string[] = [];

    // 5a. Project directory files
    if (options.projectId) {
      try {
        const projectFiles = await getAllProjectFilesRecursive(options.projectId);
        if (projectFiles.length > 0) {
          const rows = projectFiles
            .slice(0, 50) // Limit to 50 files to avoid huge prompts
            .map((f) => `| ${f.name} | ${f.path} | ${formatFileSize(f.size)} |`)
            .join("\n");
          filesSections.push(
            `### Project Directory Files\n` +
            `| File | Path | Size |\n|------|------|------|\n${rows}` +
            (projectFiles.length > 50 ? `\n\n*...and ${projectFiles.length - 50} more files*` : "")
          );
        }
      } catch {
        // Ignore errors when getting project files
      }
    }

    // 5b. Chat uploaded files
    if (options.chatId) {
      try {
        const chatFiles = await getChatFiles(options.chatId);
        if (chatFiles.length > 0) {
          const rows = chatFiles
            .map((f) => `| ${f.name} | ${f.path} | ${formatFileSize(f.size)} |`)
            .join("\n");
          filesSections.push(
            `### Chat Uploaded Files\n` +
            `| File | Path | Size |\n|------|------|------|\n${rows}`
          );
        }
      } catch {
        // Ignore errors when getting chat files
      }
    }

    if (filesSections.length > 0) {
      parts.push(
        `\n## Available Files\n` +
        `These files are available in this context. You can read them using the code_execution tool.\n\n` +
        filesSections.join("\n\n")
      );
    }
  }

  // 6. Current date/time
  parts.push(
    `\n## Current Information\n- Date/Time: ${new Date().toISOString()}\n- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
  );

  return parts.join("\n\n");
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDefaultSystemPrompt(): string {
  return `# Eggent Agent

You are a helpful AI assistant with access to tools that allow you to:
- Execute code (Python, Node.js, Shell commands)
- Save and retrieve information from persistent memory
- Search the internet for current information
- Query a knowledge base of documents
- Delegate complex subtasks to subordinate agents

## Guidelines

1. **Be helpful and direct.** Answer the user's question or complete their task.
2. **Use tools when needed.** If a task requires running code, searching, or remembering information, use the appropriate tool.
3. **Think step by step.** For complex tasks, break them down and use tools iteratively.
4. **Memory management.** Save important facts, preferences, and solutions to memory for future reference.
5. **Code execution.** When writing code, prefer Python for data processing and Node.js for web tasks. Always handle errors.
6. **Respond clearly.** Use markdown formatting for readability. Include code blocks with language tags.

## Important Rules

- Always use the response tool to provide your final answer to the user.
- If you need to execute code, use the code_execution tool.
- If the user asks you to remember something, save it to memory.
- If you need current information, use the search tool.
- Never make up information. If you don't know something, say so or search for it.`;
}
