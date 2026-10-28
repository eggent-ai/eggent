/**
 * The headers a file download gets wrong without anyone noticing.
 *
 * The first two failures were silent. A Content-Disposition carrying a Cyrillic file
 * name made the Response constructor throw - a header value is a byte string -
 * and the route's catch answered 404, so every file named in Russian was "not
 * found" while it sat in the project. And a server that ignores Range cannot be
 * played from in Safari at all: it asks for bytes 0-1 first and gives up on a
 * 200, while every other browser plays but cannot seek.
 */

import { ICS_CONTENT_TYPE, isCalendarFile } from "@/lib/calendar/ics";

export type ByteRange = { start: number; end: number };

/**
 * The type a file saved to disk is sent as. An unnamed binary for everything
 * but a calendar file: a phone saves a binary into Downloads and stops there,
 * while text/calendar makes it offer to add the event, which is the whole
 * point of the file.
 */
export function attachmentContentType(fileName: string): string {
  return isCalendarFile(fileName) ? ICS_CONTENT_TYPE : "application/octet-stream";
}

/**
 * The single byte range a request asks for, "unsatisfiable" when it asks for
 * bytes the file does not have, or null for the whole file.
 *
 * Several ranges in one request, or a unit other than bytes, are answered with
 * the whole file, which the spec allows and no media element asks for.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    // bytes=-500 is the last 500 bytes.
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  // bytes=10-5 is not a range at all, and a header that says nothing is ignored.
  if (endText && Number(endText) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: endText ? Math.min(Number(endText), size - 1) : size - 1 };
}

/**
 * A Content-Disposition any file name survives (RFC 6266): an ASCII
 * approximation for clients that read only `filename`, and the real name,
 * percent-encoded as UTF-8, in `filename*`.
 */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
