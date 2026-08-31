import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { attachToLiveRun, getLiveRun } from "@/lib/pi/live-run";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Watch the turn this chat already has in flight.
 *
 * This is the address the AI SDK reconnects to, so on the client it is one call
 * to `resumeStream()`. Answering 204 is the ordinary case and means nothing is
 * running - the stored chat is then the whole truth and the caller keeps what
 * it loaded.
 *
 * Everything the turn has already produced arrives first, in order, and the
 * rest follows live, so opening a chat mid-run looks the same as never having
 * left it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  if (!chatId) {
    return Response.json({ error: "Chat ID required" }, { status: 400 });
  }

  if (!getLiveRun(chatId)) {
    return new Response(null, { status: 204 });
  }

  const stream = createUIMessageStream<UIMessage>({
    execute: ({ writer }) =>
      new Promise<void>((resolve) => {
        // The run can end in the moment between the check above and here, and
        // then there is simply nothing to replay: an empty stream, and the
        // caller falls back on the stored chat it already has.
        const attached = attachToLiveRun(chatId, {
          onChunk: (chunk) => writer.write(chunk),
          onFinish: () => resolve(),
        });

        if (!attached) {
          resolve();
          return;
        }

        // Closing this tab ends this view of the turn and nothing else.
        req.signal.addEventListener(
          "abort",
          () => {
            attached.detach();
            resolve();
          },
          { once: true }
        );
      }),
  });

  return createUIMessageStreamResponse({ stream });
}
