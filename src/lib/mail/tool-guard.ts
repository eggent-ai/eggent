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

export const MESSAGES_TOOL_ANSWERED =
  "This was meant for eggent_messages, a tool of your own, and it has answered it below. Do not repeat the call; next time call eggent_messages directly, not mcp.";

/** Runs eggent_messages with the arguments the model gave the proxy, and answers with its text. */
export type MessagesRunner = (params: Record<string, unknown>) => Promise<string>;

/**
 * Turns such a call into what it was meant to be. Told the right name, a real
 * model still tried the proxy again up to six times; handed the answer, it has
 * nothing left to retry. A send made this way is the send the model asked for,
 * and the tool itself will not send the same thing twice (see eggent-tools).
 */
export function createMailToolGuardExtension(runner: () => MessagesRunner | null = () => null): InlineExtension {
  return {
    name: "eggent-mail-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        if (!meantForMessages(event.toolName, event.input)) return undefined;
        const run = runner();
        if (!run) return { block: true, reason: MESSAGES_TOOL_REDIRECT };
        try {
          return { block: true, reason: `${MESSAGES_TOOL_ANSWERED}\n${await run(event.input as Record<string, unknown>)}` };
        } catch {
          return { block: true, reason: MESSAGES_TOOL_REDIRECT };
        }
      });
    },
  };
}
