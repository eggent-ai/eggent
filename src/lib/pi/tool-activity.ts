/**
 * What a running tool is doing, as far as a person watching is concerned.
 *
 * One table for every surface that narrates a turn: the Telegram draft, and the
 * helper cards in the web chat, which say what each helper is busy with. Pure,
 * so the client can import it. The cloud's shared bot keeps a copy of this
 * table (its telegram-draft.ts); keep the two in step.
 */
export type ToolActivity = "search" | "page" | "files" | "command" | "helper" | "service" | "image" | "send" | "work";

const TOOL_ACTIVITIES: Record<string, ToolActivity> = {
  web_search: "search",
  source_check: "search",
  web_enable: "search",
  fetch_content: "page",
  get_search_content: "page",
  read: "files",
  write: "files",
  edit: "files",
  ls: "files",
  grep: "files",
  find: "files",
  bash: "command",
  powershell: "command",
  agent: "helper",
  subagentworkflow: "helper",
  get_subagent_result: "helper",
  steer_subagent: "helper",
  mcp: "service",
  mcpscript: "service",
  eggent_generate_image: "image",
  telegram_send_message: "send",
  telegram_send_file: "send",
};

export function toolActivity(toolName: string): ToolActivity {
  return TOOL_ACTIVITIES[toolName.toLowerCase()] ?? "work";
}
