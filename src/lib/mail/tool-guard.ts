import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * A call to the mcp proxy that was meant for eggent_messages.
 *
 * The proxy takes an `action` and a `limit` too, one of its actions is
 * "ui-messages", and a real model reached for it with eggent_messages'
 * arguments - inbox, contacts - in three turns of six, up to eight times in a
 * row, before calling the tool it meant. The proxy answers such a call with its
 * status and nothing else, so the model tries again. Turned back at once with
 * the right name, it calls the right tool on its next step.
 */
const MAIL_ACTIONS = new Set(["contacts", "inbox", "read", "send", "describe"]);

export function meantForMessages(toolName: string, input: unknown): boolean {
  if (toolName !== "mcp" || !input || typeof input !== "object") return false;
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" && MAIL_ACTIONS.has(action.trim().toLowerCase());
}

export const MESSAGES_TOOL_REDIRECT =
  "mcp has no such action. The tool you mean is eggent_messages, a tool of your own: call eggent_messages directly (not mcp), with these same arguments.";

export function createMailToolGuardExtension(): InlineExtension {
  return {
    name: "eggent-mail-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event) => (meantForMessages(event.toolName, event.input) ? { block: true, reason: MESSAGES_TOOL_REDIRECT } : undefined));
    },
  };
}
