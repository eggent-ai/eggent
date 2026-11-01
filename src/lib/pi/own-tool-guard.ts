import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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

export function createOwnToolGuardExtension(): InlineExtension {
  return {
    name: "eggent-own-tool-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "mcp") return undefined;
        const name = meantForOwnTool(event.toolName, event.input, pi.getAllTools());
        return name ? { block: true, reason: ownToolRedirect(name) } : undefined;
      });
    },
  };
}
