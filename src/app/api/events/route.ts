import { NextRequest } from "next/server";
import { subscribeUiSyncEvents } from "@/lib/realtime/event-bus";
import type { UiSyncEvent } from "@/lib/realtime/types";

export const dynamic = "force-dynamic";

function encodeSseEvent<T>(eventName: string, payload: T): Uint8Array {
  const body =
    `event: ${eventName}\n` +
    `data: ${JSON.stringify(payload)}\n\n`;
  return new TextEncoder().encode(body);
}

function encodeSseComment(comment: string): Uint8Array {
  return new TextEncoder().encode(`: ${comment}\n\n`);
}

export async function GET(req: NextRequest) {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendSync = (payload: UiSyncEvent) => {
        controller.enqueue(encodeSseEvent("sync", payload));
      };

      controller.enqueue(
        encodeSseEvent("ready", {
          at: new Date().toISOString(),
        })
      );

      unsubscribe = subscribeUiSyncEvents(sendSync);

      heartbeat = setInterval(() => {
        controller.enqueue(encodeSseComment(`ping ${Date.now()}`));
      }, 15000);

      const onAbort = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Stream may already be closed.
        }
      };

      req.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

