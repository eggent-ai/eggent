import { diffArrays, diffLines } from "diff";

/**
 * What changed between two versions of a file, shaped for reading.
 *
 * Client-safe, and shared with the server, which counts the lines a version
 * added and removed with the same code the screen draws them with - two
 * counters that disagree would make the list and the comparison under it
 * contradict each other.
 *
 * The comparison is line by line, and inside a line that changed it marks the
 * words. The words are cut with our own rule rather than the diff library's:
 * its word characters are Latin only, so a Russian sentence came apart into
 * single letters and a changed word lit up as a scatter of characters.
 */

export type DiffRowKind = "same" | "add" | "del";

export interface DiffSegment {
  kind: DiffRowKind;
  text: string;
}

export interface DiffRow {
  kind: DiffRowKind;
  /** Line number in the older version, for a line that is in it. */
  oldNo?: number;
  /** Line number in the newer version. */
  newNo?: number;
  text: string;
  /** For a changed line paired with its counterpart: which words changed. */
  segments?: DiffSegment[];
}

export type DiffBlock =
  | { type: "same"; rows: DiffRow[]; collapsed: boolean }
  /** One change: lines taken out, then lines put in; `inline` is the same change as running text. */
  | { type: "change"; index: number; removed: DiffRow[]; added: DiffRow[]; inline?: DiffSegment[] };

export interface DiffModel {
  blocks: DiffBlock[];
  /** How many separate changes, for "change 2 of 7". */
  changes: number;
  added: number;
  removed: number;
  /** Too different, or too large, to compare in reasonable time. */
  tooLarge?: boolean;
}

export interface DiffOptions {
  /** Unchanged lines shown around a change. */
  context?: number;
  /** Give up after this long rather than freeze the page. */
  timeoutMs?: number;
}

// A changed paragraph longer than this is shown as lines: marking words across
// a whole chapter costs more than it shows.
const MAX_INLINE_CHARS = 20_000;
const MAX_PAIR_CHARS = 4_000;

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split("\n");
  // A part that ends with a newline does not have one more, empty, line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

function pushSegment(segments: DiffSegment[], kind: DiffRowKind, text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

/**
 * The words two texts differ in: a sequence of kept, taken-out and put-in runs
 * that reads as the newer text with the older one's words struck through.
 */
export function wordSegments(older: string, newer: string, timeoutMs = 400): DiffSegment[] | null {
  const changes = diffArrays(tokenize(older), tokenize(newer), { timeout: timeoutMs });
  if (!changes) return null;
  const raw: DiffSegment[] = [];
  for (const change of changes) {
    const text = change.value.join("");
    pushSegment(raw, change.added ? "add" : change.removed ? "del" : "same", text);
  }
  // A single space kept between two changed words splits one edit into two
  // marks; read it as part of the edit.
  const segments: DiffSegment[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const segment = raw[index];
    const before = raw[index - 1];
    const after = raw[index + 1];
    if (
      segment.kind === "same" &&
      /^\s{1,2}$/.test(segment.text) &&
      before && after && before.kind !== "same" && after.kind !== "same"
    ) {
      pushSegment(segments, "del", segment.text);
      pushSegment(segments, "add", segment.text);
      continue;
    }
    pushSegment(segments, segment.kind, segment.text);
  }
  // Reorder so that within a run of edits the struck words come before the new ones.
  const ordered: DiffSegment[] = [];
  let pendingDel = "";
  let pendingAdd = "";
  const flush = () => {
    pushSegment(ordered, "del", pendingDel);
    pushSegment(ordered, "add", pendingAdd);
    pendingDel = "";
    pendingAdd = "";
  };
  for (const segment of segments) {
    if (segment.kind === "del") pendingDel += segment.text;
    else if (segment.kind === "add") pendingAdd += segment.text;
    else {
      flush();
      pushSegment(ordered, "same", segment.text);
    }
  }
  flush();
  return ordered;
}

/** How much of two texts is the same, from their word segments: below this a line is shown as replaced, not edited. */
function similarity(segments: DiffSegment[], older: string, newer: string): number {
  const kept = segments.filter((segment) => segment.kind === "same").reduce((sum, segment) => sum + segment.text.trim().length, 0);
  const longest = Math.max(older.trim().length, newer.trim().length, 1);
  return kept / longest;
}

function pairWords(removed: DiffRow[], added: DiffRow[]): void {
  const pairs = Math.min(removed.length, added.length);
  for (let index = 0; index < pairs; index += 1) {
    const older = removed[index].text;
    const newer = added[index].text;
    if (older.length > MAX_PAIR_CHARS || newer.length > MAX_PAIR_CHARS) continue;
    const segments = wordSegments(older, newer);
    if (!segments || similarity(segments, older, newer) < 0.35) continue;
    removed[index].segments = segments.filter((segment) => segment.kind !== "add");
    added[index].segments = segments.filter((segment) => segment.kind !== "del");
  }
}

/** Lines put in and taken out, or null when the texts are too far apart to say quickly. */
export function lineStats(older: string, newer: string, timeoutMs = 500): { added: number; removed: number } | null {
  const parts = diffLines(normalizeNewlines(older), normalizeNewlines(newer), { timeout: timeoutMs });
  if (!parts) return null;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const count = splitLines(part.value).length;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}

export function buildDiff(olderText: string, newerText: string, options: DiffOptions = {}): DiffModel {
  const context = Math.max(0, options.context ?? 3);
  const parts = diffLines(normalizeNewlines(olderText), normalizeNewlines(newerText), { timeout: options.timeoutMs ?? 2000 });
  if (!parts) return { blocks: [], changes: 0, added: 0, removed: 0, tooLarge: true };

  // First the plain sequence: runs of kept lines and changes.
  type Run = { kind: "same"; rows: DiffRow[] } | { kind: "change"; removed: DiffRow[]; added: DiffRow[] };
  const runs: Run[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lines = splitLines(part.value);
    if (lines.length === 0) continue;
    if (!part.added && !part.removed) {
      runs.push({ kind: "same", rows: lines.map((text) => ({ kind: "same", oldNo: oldNo++, newNo: newNo++, text })) });
      continue;
    }
    let last = runs[runs.length - 1];
    if (!last || last.kind !== "change") {
      last = { kind: "change", removed: [], added: [] };
      runs.push(last);
    }
    if (part.removed) {
      removed += lines.length;
      last.removed.push(...lines.map((text) => ({ kind: "del" as const, oldNo: oldNo++, text })));
    } else {
      added += lines.length;
      last.added.push(...lines.map((text) => ({ kind: "add" as const, newNo: newNo++, text })));
    }
  }

  // Then what is shown: every change, a few lines around it, and the rest folded away.
  const blocks: DiffBlock[] = [];
  let changes = 0;
  runs.forEach((run, index) => {
    if (run.kind === "change") {
      pairWords(run.removed, run.added);
      const olderPart = run.removed.map((row) => row.text).join("\n");
      const newerPart = run.added.map((row) => row.text).join("\n");
      const inline = olderPart.length + newerPart.length <= MAX_INLINE_CHARS ? wordSegments(olderPart, newerPart) ?? undefined : undefined;
      blocks.push({ type: "change", index: changes, removed: run.removed, added: run.added, ...(inline ? { inline } : {}) });
      changes += 1;
      return;
    }
    const first = index === 0;
    const lastRun = index === runs.length - 1;
    const rows = run.rows;
    const head = first ? 0 : context;
    const tail = lastRun ? 0 : context;
    if (rows.length <= head + tail + 1) {
      blocks.push({ type: "same", rows, collapsed: false });
      return;
    }
    if (head > 0) blocks.push({ type: "same", rows: rows.slice(0, head), collapsed: false });
    blocks.push({ type: "same", rows: rows.slice(head, rows.length - tail), collapsed: true });
    if (tail > 0) blocks.push({ type: "same", rows: rows.slice(rows.length - tail), collapsed: false });
  });
  if (changes === 0) return { blocks: [], changes: 0, added: 0, removed: 0 };
  return { blocks, changes, added, removed };
}
