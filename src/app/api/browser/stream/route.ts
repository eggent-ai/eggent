import { NextRequest } from "next/server";
import { browserAvailable } from "@/lib/browser/config";
import { watchBrowser, type ViewerEvent } from "@/lib/browser/viewer";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
// A panel that stops reading (a tab in the background) is let go of rather
// than buffered for: it asks again when it comes back.
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;

/**
 * GET /api/browser/stream
 *
 * The picture of the agent's browser as server-sent events: frames, the page's
 * address and title, and "closed" when the browser goes away. Only when a
 * browser is open - this never starts one.
 */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  if (!browserAvailable()) return jsonError("unavailable", 404);

  const encoder = new TextEncoder();
  let cleanup: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let stop: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the other side.
        }
      };
      const send = (event: ViewerEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (event.type === "closed") close();
        else if ((controller.desiredSize ?? 0) < -MAX_UNREAD_BYTES) close();
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, HEARTBEAT_MS);
      cleanup = close;
      try {
        stop = await watchBrowser(send);
        if (closed) stop();
      } catch (error) {
        send({ type: "closed", reason: error instanceof Error ? error.message : "unreachable" });
      }
    },
    cancel() {
      cleanup();
    },
  });
  req.signal.addEventListener("abort", () => cleanup());
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
