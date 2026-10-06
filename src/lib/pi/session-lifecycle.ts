/**
 * Ending a pi session, and binding one, the way the SDK's own runtime does.
 *
 * `AgentSession.dispose()` invalidates the extension runner and nothing more:
 * the extensions are never told the session is over. The SDK's runtime emits
 * `session_shutdown` first and disposes after; Eggent creates bare sessions and
 * called dispose alone. pi-subagents stops its scheduler on that event and on
 * no other, so a session disposed while it owned a schedule left its timers
 * armed in the process. At fire time the orphan rewrote the store file from
 * disk and threw "extension ctx is stale" into the log - and the fresh mtimes
 * it left on stores that had just been emptied are how one workspace's own
 * agent mistook a wipe for a reminder going off.
 *
 * `reload()` does stop the old scheduler and start a new one, but it emits the
 * new runner's `session_start` only to a session with bindings beyond `mode`.
 * A session restored at boot has no run, so no UI bridge, so no bindings: a
 * reload stopped its schedules and armed nothing in their place, until the
 * next restart. Every session now carries an error listener, which is a
 * binding, and is worth having for itself - an extension handler that throws
 * was otherwise dropped without a trace.
 */
import fs from "fs";
import path from "path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "@/lib/pi/provider-failure";

/** One that hangs must not keep a dead session's resources around. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export function piScheduleStorePath(session: AgentSession): string {
  return path.join(
    session.sessionManager.getCwd(),
    ".pi",
    "subagent-schedules",
    `${session.sessionId}.json`
  );
}

/**
 * Whether the session can have armed a schedule. pi-subagents arms jobs from
 * this file and writes it before arming a new one, so a session without it
 * never armed anything and needs no shutdown.
 */
export function ownsScheduleStore(session: AgentSession): boolean {
  try {
    return fs.existsSync(piScheduleStorePath(session));
  } catch {
    return false;
  }
}

/** Tell the session's extensions it is ending, as the SDK runtime does before it disposes. */
export async function shutdownSessionExtensions(session: AgentSession): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const runner = session.extensionRunner;
    if (!runner.hasHandlers("session_shutdown")) return;
    await Promise.race([
      runner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn(
      "[pi] Could not shut a session's extensions down before disposing it:",
      error instanceof Error ? error.message : error
    );
  } finally {
    clearTimeout(timer);
  }
}

/** What reaches the log when an extension handler throws. */
export function logExtensionError(error: { extensionPath?: string; event?: string; error?: string }): void {
  const extension = path.basename(String(error.extensionPath ?? "extension"));
  const message = redactSecrets(String(error.error ?? "")).replace(/\s+/g, " ").slice(0, 300);
  console.warn(`[pi-extension] ${extension} on ${error.event ?? "?"}: ${message}`);
}
