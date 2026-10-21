import { labelOf, readPage, type TextEdit } from "@/lib/files/html-source";

/**
 * The two things a page on screen asks of its file - a block it points at,
 * and the words changed in it - read the same way whether the page is this
 * workspace's own or one a colleague shared.
 */

const MAX_SOURCE_CHARS = 4000;
const MAX_EDITS = 200;
const MAX_TEXT = 20_000;

export interface PageBlock {
  label: string;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  source: string;
}

/** The block a page numbered `n`, as it is in its source; null when there is none. */
export function blockOf(source: string, n: number): PageBlock | null {
  if (!Number.isInteger(n) || n < 0) return null;
  const element = readPage(source).elements[n];
  if (!element) return null;
  const text = source.slice(element.start, element.end);
  return {
    label: labelOf(element),
    startLine: element.startLine,
    endLine: element.endLine,
    start: element.start,
    end: element.end,
    source: text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}…` : text,
  };
}

/** The changes a page sent, or null when any of them is not well formed. */
export function parseTextEdits(raw: unknown): TextEdit[] | null {
  const edits: TextEdit[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, MAX_EDITS) : []) {
    const edit = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (!Number.isInteger(edit.el) || !Number.isInteger(edit.slot) || typeof edit.was !== "string" || typeof edit.text !== "string" || edit.text.length > MAX_TEXT) {
      return null;
    }
    edits.push({ el: edit.el as number, slot: edit.slot as number, was: edit.was, text: edit.text });
  }
  return edits;
}
