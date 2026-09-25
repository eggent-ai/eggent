/**
 * Pictures a tool handed to the model, kept out of the stored copy of a chat.
 *
 * When the agent opens an image with the runtime's `read` tool, the result
 * carries the picture as base64 - that is how the model gets to see it. The
 * chat store kept that result twice, on the tool message and again on the
 * assistant's timeline, so a conversation in which the agent looked at the
 * four pictures it had just drawn weighed 13 MB for 40 messages. The chat page
 * downloads the whole conversation on every open and on every background sync,
 * which made it seven to eleven seconds of an empty transcript, every time.
 *
 * Nothing reads those bytes back. The screen shows a tool's pictures by their
 * file path, and the model's context lives in the runtime's own session rather
 * than in this copy. So the bytes are dropped and the rest of the block stays:
 * its type, and roughly how large the picture was.
 */

/** Shorter than any real picture, longer than anything that is not one. */
const MIN_INLINE_IMAGE_CHARS = 128;

/** The runtime's image content block: `{ type: "image", data, mimeType }`. */
function isInlineImage(record: Record<string, unknown>): boolean {
  return (
    record.type === "image" &&
    typeof record.mimeType === "string" &&
    typeof record.data === "string" &&
    record.data.length > MIN_INLINE_IMAGE_CHARS
  );
}

function strip(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object" || depth > 64) return value;

  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = strip(value[index], depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }

  const record = value as Record<string, unknown>;
  if (isInlineImage(record)) {
    const { data, ...rest } = record;
    // Four characters of base64 carry three bytes.
    return { ...rest, omitted: true, bytes: Math.floor(((data as string).length * 3) / 4) };
  }

  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const next = strip(record[key], depth + 1);
    if (next !== record[key]) {
      copy ??= { ...record };
      copy[key] = next;
    }
  }
  return copy ?? record;
}

/**
 * The same value without inline picture bytes. Never mutates its input, and
 * returns the input itself when there was nothing to drop, so running it over
 * a chat on every save costs a walk and no copy.
 */
export function withoutInlineImages<T>(value: T): T {
  return strip(value, 0) as T;
}
