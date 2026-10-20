import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { ownerChatIdOfHelper } from "@/lib/pi/helper-deliveries";
import {
  captureAfter,
  captureBefore,
  captureRunChanges,
  settleCommandSnapshots,
  snapshotsForCommand,
  type CommandSnapshot,
} from "@/lib/files/versions/capture";
import type { VersionAuthor } from "@/lib/files/versions/shape";

/**
 * The agent's writes, kept as versions where they happen.
 *
 * Its `write` and `edit` tools name the file: what the file held is kept just
 * before each call (if the history does not have it yet - so a change the sync
 * made between two writes of one turn is kept too), and what it holds after,
 * unless the call created the file. A command is a different matter - nobody
 * knows beforehand what `python fill.py` will write - so the files a command
 * line names are read into memory before it runs and become versions only if
 * it changed them, and when the turn ends the folder is looked through for
 * files with a history that changed while it ran (capture.ts). Several writes
 * of one turn to one file make one version: what the turn left.
 *
 * Nothing here can fail a tool. A version that could not be kept is a version
 * missing from the history, not a write the agent was refused.
 */

const WRITE_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["bash", "execute_code", "powershell", "mcp"]);

// Captures still running, so a test - or a turn's end - can wait for them.
const PENDING_KEY = Symbol.for("eggent.fileVersions.pendingCaptures");
function pendingCaptures(): Set<Promise<unknown>> {
  const holder = globalThis as unknown as Record<symbol, Set<Promise<unknown>> | undefined>;
  if (!holder[PENDING_KEY]) holder[PENDING_KEY] = new Set();
  return holder[PENDING_KEY]!;
}

function track(work: Promise<unknown>): Promise<void> {
  const pending = pendingCaptures();
  const settled = work.then(
    () => undefined,
    (error) => {
      console.warn("[versions] a version could not be kept:", error instanceof Error ? error.message : error);
    }
  );
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
  return settled;
}

/** Waits for the versions being kept right now. */
export async function settleFileVersionCaptures(): Promise<void> {
  while (pendingCaptures().size > 0) await Promise.all([...pendingCaptures()]);
}

function expandToolPath(value: string, cwd: string): string {
  let normalized = value.replace(/[  -   　]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = os.homedir();
  else if (normalized.startsWith("~/")) normalized = path.join(os.homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      // Left as it is: resolved as a name.
    }
  }
  return path.resolve(cwd, normalized);
}

/** The file a write or edit names, resolved the way the tool resolves it. */
function toolTarget(input: unknown, cwd: string): string | null {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const value = typeof record.path === "string" ? record.path : typeof record.file_path === "string" ? record.file_path : "";
  return value.trim() ? expandToolPath(value.trim(), cwd) : null;
}

function commandOf(input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof record.command === "string") return record.command;
  if (typeof record.code === "string") return record.code;
  return "";
}

/**
 * The hooks, for a session whose versions are signed by `authorOf`. Returns
 * nothing; it registers on `pi`.
 */
export function registerVersionHooks(pi: ExtensionAPI, authorOf: (ctx: ExtensionContext, run: string) => VersionAuthor | null): void {
  // One run of the agent loop: when it began, whether it ran commands, and what its commands named.
  let run = crypto.randomUUID();
  let startedAt = Date.now();
  let ranCommands = false;
  const snapshots = new Map<string, CommandSnapshot[]>();

  pi.on("agent_start", () => {
    run = crypto.randomUUID();
    startedAt = Date.now();
    ranCommands = false;
    snapshots.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName.toLowerCase();
    if (WRITE_TOOLS.has(name)) {
      const target = toolTarget(event.input, ctx.cwd);
      if (target) await track(captureBefore(target));
    } else if (COMMAND_TOOLS.has(name)) {
      ranCommands = true;
      const command = commandOf(event.input);
      if (command) {
        const taken = await snapshotsForCommand(command, ctx.cwd).catch(() => [] as CommandSnapshot[]);
        if (taken.length > 0) snapshots.set(event.toolCallId, taken);
      }
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const name = event.toolName.toLowerCase();
    const by = authorOf(ctx, run);
    if (WRITE_TOOLS.has(name)) {
      const target = toolTarget(event.input, ctx.cwd);
      if (!event.isError && target && by) await track(captureAfter(target, by, { onlyIfTracked: true }));
    } else if (COMMAND_TOOLS.has(name)) {
      // A command that failed may still have written: what it named is looked at either way.
      const taken = snapshots.get(event.toolCallId);
      snapshots.delete(event.toolCallId);
      if (taken && by) await track(settleCommandSnapshots(taken, by));
    }
    return undefined;
  });

  pi.on("agent_end", (_event, ctx) => {
    snapshots.clear();
    if (!ranCommands) return;
    ranCommands = false;
    const by = authorOf(ctx, run);
    if (by) void track(captureRunChanges({ cwd: ctx.cwd, since: startedAt, by }));
  });
}

/**
 * For a chat's own session. `runOf` is the turn it serves now - a session kept
 * for its schedules serves many - and, when it serves none (a scheduled run's
 * report), the loop's own run stands in.
 */
export function createFileVersionsExtension(binding: { chatId?: string; runOf: () => string | undefined }): InlineExtension {
  return {
    name: "eggent-file-versions",
    hidden: true,
    factory: (pi) => {
      registerVersionHooks(pi, (_ctx, run) => ({
        kind: "agent",
        ...(binding.chatId ? { chat: binding.chatId } : {}),
        run: binding.runOf() ?? run,
      }));
    },
  };
}

const HELPER_HOOKS_KEY = Symbol.for("eggent.helperHooks");

/**
 * For the helpers the agent starts, scheduled tasks among them: they are
 * sessions pi-subagents builds from the extensions on disk, and find these
 * hooks through the same bridge file that gives them their Eggent tools
 * (helper-tools.ts). Their versions are signed with the chat that started them.
 */
export function provideHelperVersionHooks(): void {
  (globalThis as unknown as Record<symbol, unknown>)[HELPER_HOOKS_KEY] = (pi: ExtensionAPI) => {
    registerVersionHooks(pi, (ctx, run) => {
      const owner = ownerChatIdOfHelper(ctx);
      return { kind: "agent", helper: true, run, ...(owner ? { chat: owner } : {}) };
    });
  };
}

provideHelperVersionHooks();
