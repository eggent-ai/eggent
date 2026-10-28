/**
 * The Eggent tools a helper started with the Agent tool may use.
 *
 * A helper is a session pi-subagents builds itself: the extensions it finds on
 * disk, and none of the tools Eggent hands a chat's own session. A scheduled
 * task always runs in one, so "tell Pyotr at ten that the meeting moved" fired
 * on time and could only report that there was no way to send - and a daily
 * post to a channel could only be done by reading the bot token and calling
 * the Bot API by hand.
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
import { emailEnabled } from "@/lib/email/config";
import { createEmailTool } from "@/lib/email/tool";
import { createTelegramTools } from "@/lib/telegram/tools";
import { resolveTelegramDestination } from "@/lib/telegram/outbound";
import { afterTelegramDelivery } from "@/lib/telegram/conversation";
import { getActiveRun } from "@/lib/pi/active-runs";
import { noteHelperDelivery, ownerChatIdOfHelper } from "@/lib/pi/helper-deliveries";

export const HELPER_TOOLS_FILE = "eggent-helper-tools.js";
const PROVIDER_KEY = Symbol.for("eggent.helperTools");

const EXTENSION_SOURCE = `// Written by Eggent at start and rewritten on every start; edits are lost.
// Gives a helper started with the Agent tool the Eggent tools it may use, and
// keeps the versions of the files it writes.
export default function eggentHelperTools(pi) {
  const hooks = globalThis[Symbol.for("eggent.helperHooks")];
  if (typeof hooks === "function") hooks(pi);
  const provide = globalThis[Symbol.for("eggent.helperTools")];
  if (typeof provide !== "function") return;
  for (const tool of provide()) pi.registerTool(tool);
}
`;

function helperTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // A helper reads for nobody: what it reads stays unread for the person.
  if (mailEnabled()) tools.push(createMessagesTool({ marksRead: () => false }) as unknown as ToolDefinition);
  // A helper writes to the person, and nobody is there to say yes to a letter
  // to anybody else: on a server of one's own those are refused here.
  if (emailEnabled()) tools.push(createEmailTool({ marksRead: () => false }) as unknown as ToolDefinition);
  tools.push(...createTelegramTools({
    // A helper answers no Telegram message of its own: the person's chat is the
    // one the workspace remembers, a channel needs the workspace's own bot.
    destination: (chat) => resolveTelegramDestination(null, chat ? { chat } : {}),
    // The run's chat does not exist yet while its helper works; the host's own
    // delivery would have said which chat it is from.
    footerTitle: async () => null,
    afterOwnChat: async (destination, result, kind, ctx) => {
      if (!result.success) return;
      const owner = ownerChatIdOfHelper(ctx);
      if (!owner) return;
      // A helper of a turn somebody is in: what it sent belongs to that chat.
      if (getActiveRun(owner)) {
        await afterTelegramDelivery({ destination, result, chatId: owner });
        return;
      }
      // A scheduled task's helper: the report turn that follows takes it from here.
      noteHelperDelivery(owner, { destination, result, kind });
    },
  }));
  return tools;
}

/** Makes the tools reachable from the extension file; any copy of this module may do it. */
export function provideHelperTools(): void {
  (globalThis as Record<symbol, unknown>)[PROVIDER_KEY] = helperTools;
}

/**
 * Writes the extension file, or rewrites one an older build left. Outside an
 * Eggent process the file registers nothing: the tools come from this module.
 */
export function ensureHelperToolsExtension(agentDir: string): void {
  const file = path.join(agentDir, "extensions", HELPER_TOOLS_FILE);
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
