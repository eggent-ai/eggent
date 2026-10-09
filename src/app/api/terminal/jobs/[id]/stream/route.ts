import { NextRequest } from "next/server";
import { authorizeJobRequest } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";
import type { TerminalStreamEvent } from "@/lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One event per this many characters of replay, so a late reader is not one huge frame. */
const REPLAY_FRAME_CHARS = 32 * 1024;
const HEARTBEAT_MS = 15_000;
/**
 * How much may wait unread before the connection is let go. A reader that has
 * stopped reading (a tab in the background, a phone that went to sleep with the
 * socket still open) would otherwise make the server hold everything a busy
 * command prints, for as long as the connection stays. Let go of, it comes back
 * with the offset it reached and is given the rest from the job's own buffer.
 */
const MAX_UNREAD_BYTES = 4 * 1024 * 1024;

/**
 * GET /api/terminal/jobs/:id/stream?from=<offset>
 *
 * The output of a job as server-sent events, from `from` on. The request ends
 * when the job does. Dropping it leaves the job running; asking again with the
 * last offset seen continues exactly where it stopped.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeJobRequest(req, params, { write: false });
  if ("failure" in authorized) return failureResponse(req, authorized.failure);
  const { id, registry } = authorized.context;
  const from = Number.parseInt(req.nextUrl.searchParams.get("from") ?? "0", 10);

  const encoder = new TextEncoder();
  let cleanup: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let detach: () => void = () => undefined;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (event: TerminalStreamEvent, live = true) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        // Frames already queued are still delivered after the stream is closed.
        // Only live output counts: the replay a reader asked for is what it
        // is owed, and letting go of it half way would make it ask again for
        // the same thing.
        if (live && (controller.desiredSize ?? 0) < -MAX_UNREAD_BYTES) close();
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        detach();
        try {
          controller.close();
        } catch {
          // Already closed by the other side.
        }
      };
      cleanup = close;

      const attachment = registry.attach(id, from, {
        onOutput: (d, n) => send({ t: "o", d, n }),
        onExit: (info) => {
          send({ t: "x", ...info });
          close();
        },
      });
      if (!attachment) {
        send({ t: "x", code: null, signal: null, reason: "error" });
        close();
        return;
      }
      detach = attachment.detach;

      send(
        {
          t: "s",
          from: attachment.start,
          total: attachment.total,
          state: attachment.state,
          truncated: attachment.truncated,
        },
        false
      );
      let offset = attachment.start;
      for (let i = 0; i < attachment.replay.length; i += REPLAY_FRAME_CHARS) {
        const piece = attachment.replay.slice(i, i + REPLAY_FRAME_CHARS);
        offset += piece.length;
        send({ t: "o", d: piece, n: offset }, false);
      }
      if (attachment.exit) {
        send({ t: "x", ...attachment.exit }, false);
        close();
        return;
      }

      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, HEARTBEAT_MS);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps the framework's compression from holding output back.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
