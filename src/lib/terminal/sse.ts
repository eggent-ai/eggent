/**
 * Reading server-sent events from a `fetch` body.
 *
 * `EventSource` cannot be used here: it reconnects on its own with no say in
 * where from, cannot be told to stop once the job has ended, and every
 * automatic reconnection is a new request that looks like activity to a
 * workspace deciding whether it is idle. Reading the stream by hand keeps all
 * three decisions in our hands.
 */
export async function* readEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as T;
        } catch {
          // A frame that is not ours (a proxy's notice) is not worth stopping for.
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already released.
    }
  }
}
