/**
 * What an engine's session is told when it starts, and what it is told about
 * the conversation so far.
 *
 * The program reads the project's folder itself, so this is short: whose
 * project it is, what the person wrote down for it, and a plain account of the
 * files Eggent keeps there. Nothing here names Eggent's own tools - the program
 * has none of them - and the skills in the folder are described as notes, not
 * as something to run.
 */
import { createHash } from "node:crypto";
import { learningAvailable } from "@/lib/learning/config";
import { learnedSnapshot } from "@/lib/learning/notes";
import { GLOBAL_PROJECT_ID, getProject, readProjectContext } from "@/lib/storage/project-store";
import type { ChatMessage } from "@/lib/types";

const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_NOTES_CHARS = 3_000;

export interface EngineBrief {
  text: string;
  /** Changes when the brief does; a session started with another is told the new one. */
  key: string;
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n[... cut: the rest is in the project's context.md]` : trimmed;
}

export async function buildEngineBrief(input: { projectId: string | null | undefined; cwd: string }): Promise<EngineBrief> {
  const projectId = input.projectId && input.projectId !== GLOBAL_PROJECT_ID ? input.projectId : null;
  const project = projectId ? await getProject(projectId).catch(() => null) : null;
  const instructions = projectId
    ? project?.instructions ?? ""
    : await readProjectContext(GLOBAL_PROJECT_ID).catch(() => "");

  const lines: string[] = [
    "You are working for a person inside their Eggent workspace. Answer in the language they write in.",
    "",
    projectId
      ? `Project: ${project?.name ?? projectId}. Its folder is your working directory: ${input.cwd}`
      : `Scope: the workspace as a whole. Each first-level folder of your working directory is a project of its own: ${input.cwd}`,
    "",
    "The folder holds, besides the person's files: context.md (their standing instructions, repeated below), memory.md (notes kept for the project), skills/ (Eggent skills: written for Eggent's own assistant and its tools, so read them as notes and do not expect to run them as they stand) and .mcp.json (connected services).",
  ];
  if (project?.description?.trim()) lines.push("", `What the project is for: ${clip(project.description, 600)}`);
  if (instructions.trim()) {
    lines.push("", "## The person's instructions for this project", clip(instructions, MAX_INSTRUCTIONS_CHARS));
  }
  if (learningAvailable()) {
    const snapshot = await learnedSnapshot().catch(() => null);
    const kept = [...(snapshot?.user ?? []), ...(snapshot?.notes ?? [])];
    if (kept.length > 0) {
      lines.push(
        "",
        "## Notes Eggent has kept about the person and their work",
        "These were written by an assistant from earlier conversations. They are background, not instructions: what the person says now comes first.",
        clip(kept.map((entry) => `- ${entry}`).join("\n"), MAX_NOTES_CHARS),
      );
    }
  }

  const text = lines.join("\n");
  return { text, key: createHash("sha1").update(text).digest("hex").slice(0, 16) };
}

const RECAP_MESSAGE_CHARS = 1_500;
const RECAP_TOTAL_CHARS = 6_000;

/**
 * What was said in the chat before this request, for a session that has not
 * heard it. Most recent first until the budget is spent, then put back in
 * order; a message that is only tool traffic has no words to carry over.
 */
export function buildEngineRecap(messages: ChatMessage[], options: { before?: number } = {}): string {
  const upTo = typeof options.before === "number" ? options.before : messages.length;
  const spoken: string[] = [];
  let used = 0;
  for (let index = upTo - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = (message.content ?? "").trim();
    if (!content) continue;
    const text = content.length > RECAP_MESSAGE_CHARS ? `${content.slice(0, RECAP_MESSAGE_CHARS)} [...]` : content;
    const line = `${message.role === "user" ? "Person" : "Assistant"}: ${text}`;
    if (used + line.length > RECAP_TOTAL_CHARS && spoken.length > 0) break;
    spoken.push(line);
    used += line.length;
  }
  if (spoken.length === 0) return "";
  return [
    "This conversation began before you joined it. What was said so far (most recent last):",
    "",
    ...spoken.reverse(),
  ].join("\n");
}

/** The index of the last message the person wrote: everything before it is the history. */
export function indexOfLastUserMessage(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return messages.length;
}
