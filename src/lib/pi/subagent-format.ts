/**
 * Reading the Agent tool, shared by the server that tracks helpers and the
 * chat that draws them. Pure on purpose: no node modules, so the client can
 * import it without pulling the runtime along.
 */

export const AGENT_TOOL_NAME = "Agent";

export function isAgentToolName(name: unknown): boolean {
  return typeof name === "string" && name.toLowerCase() === "agent";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The text of a tool result, whether it arrives as a string or as `{ content }`. */
export function toolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  const content = asRecord(output)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const COMPLETED_HEADLINE = /^Agent completed in [^\n]*$/m;
const FAILED_HEADLINE = /^Agent failed: ([^\n]*)$/m;

/**
 * What a helper found, separated from the line the extension puts in front of
 * it for the model ("Agent completed in 1m 10s (9 tool uses, 12.3k token).").
 * A failed helper keeps its reason apart from whatever partial output it left.
 */
export function splitAgentResult(text: string): { result: string; error?: string } {
  const failed = text.match(FAILED_HEADLINE);
  if (failed && failed.index !== undefined && failed.index < 400) {
    const rest = text.slice(failed.index + failed[0].length).trim();
    return { result: rest, error: failed[1].trim() || undefined };
  }
  const completed = text.match(COMPLETED_HEADLINE);
  if (completed && completed.index !== undefined && completed.index < 400) {
    return { result: text.slice(completed.index + completed[0].length).trim() };
  }
  return { result: text.trim() };
}

/** "12.3k token" and "1.2M token" from the extension, as a number. */
export function parseTokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^([\d.]+)\s*([kKmM]?)/);
  if (!match) return undefined;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const scale = match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(base * scale);
}

// What the extension says a helper is doing, back to the tool it is doing it
// with. Its own words are for a terminal and English; the chat names the tool
// in the reader's language instead.
const ACTIVITY_VERBS: Record<string, string> = {
  reading: "read",
  "running command": "bash",
  editing: "edit",
  writing: "write",
  searching: "grep",
  "finding files": "find",
  listing: "ls",
};

/**
 * The extension's one-line activity - "thinking…", "web_search…",
 * "reading 2 files, bash…", "queued — waiting for a foreground slot", or the
 * start of what the helper is writing - as something the chat can say in the
 * reader's language.
 */
export function parseSubagentActivity(activity: unknown): {
  kind: "thinking" | "queued" | "tool" | "writing";
  tools?: string[];
  text?: string;
} | undefined {
  if (typeof activity !== "string") return undefined;
  const text = activity.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (/^thinking\b/i.test(text)) return { kind: "thinking" };
  if (/^queued\b/i.test(text)) return { kind: "queued" };
  if (text.endsWith("…")) {
    const tools = text
      .slice(0, -1)
      .split(", ")
      .map((part) => part.replace(/ \d+ (?:files|patterns)$/, "").trim())
      .map((part) => ACTIVITY_VERBS[part] ?? part);
    if (tools.length && tools.every((tool) => /^[A-Za-z][\w.:-]*$/.test(tool))) {
      return { kind: "tool", tools: [...new Set(tools)] };
    }
  }
  return { kind: "writing", text: text.length > 160 ? `${text.slice(0, 159)}…` : text };
}
