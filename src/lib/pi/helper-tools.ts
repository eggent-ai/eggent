/**
 * The Eggent tools a helper started with the Agent tool may use.
 *
 * A helper is a session pi-subagents builds itself: the extensions it finds on
 * disk, and none of the tools Eggent hands a chat's own session. A scheduled
 * task always runs in one, so "tell Pyotr at ten that the meeting moved" fired
 * on time and could only report that there was no way to send.
 *
 * The bridge is one small extension file in the agent's own extensions folder,
 * which every session would discover; it asks this module, in the same process,
 * for the tools and registers them. A chat's own session leaves the file out
 * (`withoutHelperTools`), because it already has the tools and a schema is
 * billed on every turn.
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mailEnabled } from "@/lib/mail/config";
import { createMessagesTool } from "@/lib/mail/tool";

export const HELPER_TOOLS_FILE = "eggent-helper-tools.js";
const PROVIDER_KEY = Symbol.for("eggent.helperTools");
const MARKER = "Written by Eggent";

const EXTENSION_SOURCE = `// ${MARKER} at start and rewritten on every start; edits are lost.
// Gives a helper started with the Agent tool the Eggent tools it may use.
export default function eggentHelperTools(pi) {
  const provide = globalThis[Symbol.for("eggent.helperTools")];
  if (typeof provide !== "function") return;
  for (const tool of provide()) pi.registerTool(tool);
}
`;

function helperTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // A helper reads for nobody: what it reads stays unread for the person.
  if (mailEnabled()) tools.push(createMessagesTool({ marksRead: () => false }) as unknown as ToolDefinition);
  return tools;
}

/** Makes the tools reachable from the extension file; any copy of this module may do it. */
export function provideHelperTools(): void {
  (globalThis as Record<symbol, unknown>)[PROVIDER_KEY] = helperTools;
}

/**
 * Writes the extension file when there is a tool to hand over, and removes a
 * file of ours when there is none, so a self-hosted install without messages
 * keeps an agent folder with nothing of ours in it.
 */
export function ensureHelperToolsExtension(agentDir: string): void {
  const file = path.join(agentDir, "extensions", HELPER_TOOLS_FILE);
  if (!mailEnabled()) {
    try {
      if (fs.readFileSync(file, "utf8").includes(MARKER)) fs.unlinkSync(file);
    } catch {
      // Not there.
    }
    return;
  }
  try {
    if (fs.readFileSync(file, "utf8") === EXTENSION_SOURCE) return;
  } catch {
    // Not written yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, EXTENSION_SOURCE);
  fs.renameSync(temp, file);
}

/** For a chat's own session: the bridge is for helpers only. */
export function withoutHelperTools<T extends { extensions: Array<{ path: string }> }>(result: T): T {
  return { ...result, extensions: result.extensions.filter((extension) => path.basename(extension.path) !== HELPER_TOOLS_FILE) };
}

provideHelperTools();
