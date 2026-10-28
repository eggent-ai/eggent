import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * A call to the mcp proxy that was meant for eggent_email.
 *
 * The proxy takes an `action` too, and a model reached for it with another
 * Eggent tool's arguments in most of its turns before calling the tool it
 * meant (lib/mail/tool-guard). Turned back at once with the right name, it
 * calls the right tool on its next step. A letter is never sent from here: the
 * call is only redirected.
 */
const EMAIL_ACTIONS = new Set(["send_email", "list_emails", "read_email", "email_status", "my_address"]);

export function meantForEmail(toolName: string, input: unknown): boolean {
  if (toolName !== "mcp" || !input || typeof input !== "object") return false;
  const action = (input as Record<string, unknown>).action;
  return typeof action === "string" && EMAIL_ACTIONS.has(action.trim().toLowerCase());
}

export const EMAIL_TOOL_REDIRECT =
  "mcp has no such action. The tool you mean is eggent_email, a tool of your own: call eggent_email directly (not mcp), with these same arguments.";

export function createEmailToolGuardExtension(): InlineExtension {
  return {
    name: "eggent-email-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => (meantForEmail(event.toolName, event.input) ? { block: true, reason: EMAIL_TOOL_REDIRECT } : undefined));
    },
  };
}
