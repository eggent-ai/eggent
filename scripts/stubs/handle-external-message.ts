/**
 * Stands in for the external message handler in tests.
 *
 * The real one runs a whole agent turn, which is the one thing a test of the
 * Telegram handler or of the external routes does not need: what it needs is a
 * turn that fails, or answers, the way the test says. A test sets
 * `globalThis.__eggentTestTurn` to an error to throw or a reply to return, and
 * may give `deltas`, the pieces of text reported while the turn "runs".
 */
export class ExternalMessageError extends Error {
  status: number;
  payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : `External message failed with status ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

export function describeExternalError(
  error: unknown,
  fallback: string
): { status: number; payload: Record<string, unknown> } {
  if (error instanceof ExternalMessageError) {
    return { status: error.status, payload: error.payload };
  }
  return { status: 500, payload: { error: error instanceof Error ? error.message : fallback } };
}

type TestTurn = { error?: unknown; reply?: string; deltas?: string[] };
type ProgressInput = { onProgress?: (event: { type: "text"; delta: string }) => void };

export async function handleExternalMessage(
  input?: ProgressInput
): Promise<{ reply: string; context: { activeProjectName: string | null } }> {
  const turn = (globalThis as { __eggentTestTurn?: TestTurn }).__eggentTestTurn || {};
  for (const delta of turn.deltas || []) {
    input?.onProgress?.({ type: "text", delta });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (turn.error !== undefined) throw turn.error;
  return { reply: turn.reply || "ok", context: { activeProjectName: null } };
}

export const handleExternalMediaMessage = handleExternalMessage;

export function isChatCommand(message: string): boolean {
  return /^\/(chats|c_[a-z0-9]{4,32})(@\w+)?(\s|$)/i.test(message.trim());
}
