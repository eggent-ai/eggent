import fs from "node:fs";
import path from "node:path";

/**
 * A project's MCP servers, and who may start them.
 *
 * pi-mcp-adapter starts a server from a project's .mcp.json only once somebody
 * has allowed it. With a card to show, it asks; with no way to show one - an
 * external-API or messenger turn, a helper, a scheduled run - the server is
 * skipped, and the agent then tells the person that a tool they connected does
 * not exist.
 *
 * Where a deployment says so, the workspace's own files count as allowed: the
 * agent running there already has a shell, so a server is one more command it
 * could have run anyway, and the question protects nothing. A public link never
 * reaches this - a session answering one loads no extensions at all.
 */
export function mcpWorkspaceTrusted(): boolean {
  return process.env.EGGENT_MCP_TRUST_WORKSPACE === "1";
}

const APPROVAL_QUESTION = /^Allow project MCP server\b/;

/** Answering yes is what makes the adapter keep its own record of the approval. */
export function isProjectMcpApprovalQuestion(title: string): boolean {
  return APPROVAL_QUESTION.test(title);
}

const ADAPTER_CONFIG = "mcp-adapter.json";

/**
 * The adapter asks nobody in a session with no UI at all, and goes by this
 * setting instead. It is read only from the user-global file: a project's own
 * .mcp.json cannot grant itself this.
 */
export function ensureMcpTrustPolicy(agentDir: string): void {
  if (!mcpWorkspaceTrusted()) return;
  const file = path.join(agentDir, ADAPTER_CONFIG);
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Somebody's own file that does not parse is theirs to fix, not ours to replace.
      console.warn(`MCP: left ${file} alone: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  const settings = (config.settings && typeof config.settings === "object" && !Array.isArray(config.settings)
    ? config.settings
    : {}) as Record<string, unknown>;
  if (settings.projectServers === "allow") return;
  const next = { mcpServers: {}, ...config, settings: { ...settings, projectServers: "allow" } };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
const RUNTIME_REGISTER_VERSION = 1;

type ExtensionEvents = { emit(channel: string, data: unknown): void };

/**
 * Tell a running adapter about a server just written to .mcp.json, so it can be
 * used in the same turn - the adapter's own way in, for servers that appear after
 * it started. Fails closed: a name it already holds, or no adapter, answers false,
 * and the server comes into use with the next session instead.
 */
export function registerMcpServerNow(events: ExtensionEvents | null, name: string, definition: unknown): boolean {
  if (!events || !mcpWorkspaceTrusted()) return false;
  const request: { version: number; name: string; definition: unknown; result?: { ok: boolean } } = {
    version: RUNTIME_REGISTER_VERSION,
    name,
    definition,
  };
  try {
    events.emit(RUNTIME_REGISTER_EVENT, request);
  } catch {
    return false;
  }
  return request.result?.ok === true;
}
