/**
 * Whether a message shows the agent opening its browser: a shell command that
 * runs `eggent-browser open`. The name alone proves nothing, because a skill the
 * agent read mentions it, and that text sits in the same message.
 */
const OPENS_BROWSER = /(?:^|[;&|(\n])\s*eggent-browser\s+open\b/;

export function agentOpenedBrowser(parts: readonly unknown[] | undefined): boolean {
  return (parts ?? []).some((raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const part = raw as { type?: unknown; toolName?: unknown; input?: unknown };
    const name = part.type === "dynamic-tool" ? part.toolName : typeof part.type === "string" && part.type.startsWith("tool-") ? part.type.slice(5) : null;
    if (typeof name !== "string" || name.toLowerCase() !== "bash") return false;
    const command = typeof part.input === "object" && part.input !== null ? (part.input as { command?: unknown }).command : null;
    return typeof command === "string" && OPENS_BROWSER.test(command);
  });
}
