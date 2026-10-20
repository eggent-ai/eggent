/**
 * Reading a server-sent event stream, one event's data at a time.
 *
 * The chat stream is the AI SDK's: each part is one `data: <json>` event and
 * the stream ends with `data: [DONE]`. Comment lines (`: ...`) carry nothing
 * and exist to keep a quiet connection from being closed by whatever sits
 * between the two sides, so they are skipped here and never reach a caller.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events end with a blank line; both line endings are legal.
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = dataOf(raw);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const rest = dataOf(buffer);
    if (rest !== null) yield rest;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A read still pending on a cancelled stream; nothing to release.
    }
  }
}

function dataOf(rawEvent: string): string | null {
  const lines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    // The single space after the colon belongs to the syntax, not the data.
    lines.push(line.slice(5).replace(/^ /, ""));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** One event as the wire carries it. */
export function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}
