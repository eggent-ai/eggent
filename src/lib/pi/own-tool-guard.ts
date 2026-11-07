import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { STAGE_TOOL } from "@/lib/employees/stage";
import { createStageTool } from "@/lib/employees/stage-tool";

/**
 * A call to the mcp proxy that was meant for one of the session's own tools.
 *
 * The proxy takes an `action`, and a model that means an Eggent tool reaches
 * for it with that tool's arguments: a new workspace asked to go back to
 * Telegram called `mcp({action: "status", bot_token: "", mode: ""})` seven
 * times in a row - 25 seconds of a first impression - before calling
 * eggent_manage_telegram. The proxy answers such a call with its own status and
 * nothing else, so the model tries again. Turned back at once with the right
 * name, it calls the right tool on its next step.
 *
 * Messages and email had guards of their own (lib/mail, lib/email); this one
 * covers every tool the session has, by reading their schemas, so a new tool
 * needs nothing here.
 */

/** What the proxy itself is called with: a call carrying any of these is the proxy's. */
const PROXY_CALL_KEYS = new Set(["tool", "args", "connect", "describe", "instructions", "search", "url"]);
const PROXY_ACTIONS = new Set(["install", "ui-messages", "auth-start", "auth-complete"]);

export interface OwnToolInfo {
  name: string;
  parameters?: unknown;
}

function schemaProperties(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" ? (properties as Record<string, unknown>) : null;
}

/** The fixed values a property allows, from TypeBox literals, unions or a plain enum; null when it allows any. */
function allowedValues(schema: unknown): Set<string> | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { const?: unknown; enum?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (typeof s.const === "string") return new Set([s.const]);
  if (Array.isArray(s.enum)) return new Set(s.enum.filter((value): value is string => typeof value === "string"));
  const options = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (!options) return null;
  const values = new Set<string>();
  for (const option of options) {
    const inner = allowedValues(option);
    if (!inner) return null;
    for (const value of inner) values.add(value);
  }
  return values;
}

/**
 * The own tool this proxy call was meant for, or null when it is the proxy's.
 * Every key the model sent must be one of that tool's parameters, and an
 * `action` must be one it accepts; of several that fit, the one whose action
 * list names it wins, then the one with the fewest parameters left unused.
 */
export function meantForOwnTool(toolName: string, input: unknown, tools: readonly OwnToolInfo[]): string | null {
  if (toolName !== "mcp" || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const params = input as Record<string, unknown>;
  const keys = Object.keys(params);
  if (keys.length === 0 || keys.some((key) => PROXY_CALL_KEYS.has(key))) return null;
  const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : null;
  if (action !== null && PROXY_ACTIONS.has(action)) return null;
  // The proxy's own `server`, `limit` and the like sent alone are the proxy's too.
  if (action === null && keys.length < 2) return null;

  let best: { name: string; named: boolean; spare: number } | null = null;
  for (const tool of tools) {
    if (tool.name === "mcp") continue;
    const properties = schemaProperties(tool.parameters);
    if (!properties || !keys.every((key) => key in properties)) continue;
    let named = false;
    if (action !== null) {
      const values = allowedValues(properties.action);
      if (values) {
        if (!values.has(action)) continue;
        named = true;
      }
    }
    const spare = Object.keys(properties).length - keys.length;
    if (!best || (named && !best.named) || (named === best.named && spare < best.spare)) {
      best = { name: tool.name, named, spare };
    }
  }
  return best?.name ?? null;
}

export function ownToolRedirect(name: string): string {
  return `mcp has no such action. The tool you mean is ${name}, a tool of your own: call ${name} directly (not mcp), with these same arguments.`;
}

/**
 * Stages are the one call that is run rather than turned back. Told the right
 * name, a real model sometimes carried on without it (1 first job in 18), and
 * the person watched a whole job with no board. Nothing here can go wrong by
 * running it: a stage changes nothing but what the screen shows.
 */
export const STAGE_ANSWERED =
  "Done: this was meant for eggent_stage, a tool of your own, and the stage is on the person's screen. Do not repeat it; next time call eggent_stage directly (not mcp).";

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { text?: unknown })?.text).filter((text) => typeof text === "string").join("");
}

/**
 * What the runners see of a stage that came through the proxy: a stage. The
 * screen and the stored chat read tool names, so without this the board stays
 * empty however well the call was answered. What the model sent and was told
 * stays as it was in its own record.
 */
export function createProxiedStageReader(getTools: () => readonly OwnToolInfo[]) {
  const proxied = new Set<string>();
  return <T extends Record<string, unknown>>(record: T): T => {
    if (record.toolName !== "mcp" || typeof record.toolCallId !== "string") return record;
    if (record.type === "tool_execution_start") {
      if (meantForOwnTool("mcp", record.args, getTools()) !== STAGE_TOOL) return record;
      proxied.add(record.toolCallId);
      return { ...record, toolName: STAGE_TOOL };
    }
    if (record.type !== "tool_execution_end" || !proxied.delete(record.toolCallId)) return record;
    const text = resultText(record.result);
    if (!text.startsWith(STAGE_ANSWERED)) return { ...record, toolName: STAGE_TOOL };
    return {
      ...record,
      toolName: STAGE_TOOL,
      isError: false,
      result: { content: [{ type: "text", text: text.slice(STAGE_ANSWERED.length).trim() }] },
    };
  };
}

export function createOwnToolGuardExtension(): InlineExtension {
  return {
    name: "eggent-own-tool-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "mcp") return undefined;
        const name = meantForOwnTool(event.toolName, event.input, pi.getAllTools());
        if (!name) return undefined;
        if (name === STAGE_TOOL) {
          try {
            const tool = createStageTool({ cwd: ctx.cwd });
            const result = await tool.execute(event.toolCallId, event.input as never, undefined, undefined, ctx as never);
            return { block: true, reason: `${STAGE_ANSWERED}\n${resultText(result)}` };
          } catch {
            // Fall through to the name: the model can still call it itself.
          }
        }
        return { block: true, reason: ownToolRedirect(name) };
      });
    },
  };
}
