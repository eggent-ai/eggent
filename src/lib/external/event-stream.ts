import type { AgentProgressEvent } from "@/lib/pi/types";

/**
 * An external turn as server-sent events, for a caller that shows the answer
 * while it is being written - a messenger bot streaming a draft, say.
 *
 * Asked for with `Accept: text/event-stream`; anything else still gets the one
 * JSON document at the end, so a caller that knows nothing of this keeps
 * working. Each event is a JSON object on a `data:` line:
 *
 *   {"type":"text","delta":"..."}                   a piece of the answer
 *   {"type":"tool","name":"...","phase":"start"}    a tool began or ended
 *   {"type":"done","result":{...}}                  what the JSON route returns
 *   {"type":"error","status":500,"payload":{...}}   what the JSON route would
 *                                                   have answered with a status
 *
 * The turn belongs to the chat, not to this connection: a caller that goes away
 * mid-answer stops receiving, and the turn finishes and is stored as usual.
 */

export function wantsEventStream(req: Request): boolean {
  return (req.headers.get("accept") || "").includes("text/event-stream");
}

// A comment line now and then: a turn can work for minutes without a word of
// text, and an idle connection is what proxies close first.
const KEEPALIVE_MS = 15_000;

export function externalTurnEventStream<T>(
  run: (onProgress: (event: AgentProgressEvent) => void) => Promise<T>,
  describeError: (error: unknown) => { status: number; payload: Record<string, unknown> }
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: Record<string, unknown>) => write(`data: ${JSON.stringify(event)}\n\n`);
      const keepalive = setInterval(() => write(": ping\n\n"), KEEPALIVE_MS);
      try {
        const result = await run((event) => send(event));
        send({ type: "done", result });
      } catch (error) {
        const { status, payload } = describeError(error);
        send({ type: "error", status, payload });
      } finally {
        clearInterval(keepalive);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by the reader going away.
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
