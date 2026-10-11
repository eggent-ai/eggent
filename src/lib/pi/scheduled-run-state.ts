/**
 * Which sessions are carrying out a scheduled run right now.
 *
 * A scheduled task is two agents. A helper does the work with no memory of the
 * conversation and none of the workspace's tools; when it finishes, its result
 * is sent to the session that owns the schedule, and that session's turn - with
 * every tool, `bash` among them - writes the report. Nobody is in that turn. The
 * instruction not to touch the schedule is stored in the helper's prompt, so
 * the turn that actually has the tools never read it, and a report turn on a
 * real workspace deleted the very task it was reporting on.
 *
 * Knowing that "this session is in a scheduled run" is what lets the tools
 * refuse. It is kept as session ids because a tool hook is given the session's
 * manager, not the session, and on the global object because the host that sets
 * it and the routes that read it are compiled separately.
 */

const KEY = "__EGGENT_SCHEDULED_RUN_SESSIONS__";

function sessions(): Set<string> {
  const holder = globalThis as typeof globalThis & { [KEY]?: Set<string> };
  if (!holder[KEY]) holder[KEY] = new Set<string>();
  return holder[KEY];
}

export function markScheduledRunSession(sessionId: string): void {
  if (sessionId) sessions().add(sessionId);
}

export function unmarkScheduledRunSession(sessionId: string): void {
  if (sessionId) sessions().delete(sessionId);
}

export function isScheduledRunSessionId(sessionId?: string | null): boolean {
  return Boolean(sessionId) && sessions().has(sessionId as string);
}

/** What the model is told when it tries. It reads this, so it says what to do instead. */
export const SCHEDULED_RUN_REFUSAL =
  "This turn is the report of a scheduled run and no person is in it, so scheduled tasks cannot be created, changed or deleted from here. "
  + "Tell the person what you found and leave the tasks as they are; they can change a task in a chat of their own.";
