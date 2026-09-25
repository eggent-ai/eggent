/**
 * Stands in for the external message handler in tests.
 *
 * The real one runs a whole agent turn, which is the one thing a test of the
 * Telegram handler does not need: what it needs is a turn that fails, or
 * answers, the way the test says. A test sets `globalThis.__eggentTestTurn` to
 * an error to throw or a reply to return.
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

type TestTurn = { error?: unknown; reply?: string };

export async function handleExternalMessage(): Promise<{ reply: string; context: { activeProjectName: string | null } }> {
  const turn = (globalThis as { __eggentTestTurn?: TestTurn }).__eggentTestTurn || {};
  if (turn.error !== undefined) throw turn.error;
  return { reply: turn.reply || "ok", context: { activeProjectName: null } };
}
