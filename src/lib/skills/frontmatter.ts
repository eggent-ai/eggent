/**
 * The header of a SKILL.md: the YAML between the first two `---` lines.
 *
 * Two things read it and they do not agree. The agent runtime parses it as real
 * YAML and quietly drops a skill whose header it cannot parse, while the
 * workspace's own listing has always read it line by line and so accepted
 * headers that no YAML parser does - `description: Use when: the user asks` is
 * the usual one. Checking an uploaded skill against only the second would admit
 * files the runtime then ignores, so the check here is the runtime's: the same
 * library at the same version, splitting the file at the same place.
 *
 * The listing gets the better reader too (`readFrontmatterStrings`), so a
 * description written as a folded block no longer shows up as a lone `>`.
 */
import { parse, YAMLParseError } from "yaml";

export type SkillFileSplit =
  | { ok: true; block: string; body: string }
  | { ok: false; reason: "missing" | "unclosed" };

/**
 * Split a SKILL.md into its header and its instructions.
 *
 * The runtime looks for `---` at the very start of the file and for the next
 * line that begins with `---`; a file with anything before the opening line has
 * no header as far as it is concerned, so neither does this.
 */
export function splitSkillFile(text: string): SkillFileSplit {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!/^---[ \t]*(\n|$)/.test(normalized)) return { ok: false, reason: "missing" };

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { ok: false, reason: "unclosed" };
  const lineEnd = normalized.indexOf("\n", end + 1);
  // `----` or `---text` would end the header for the runtime and start the
  // instructions with a stray dash. A closing line is `---` and nothing else.
  if (normalized.slice(end + 4, lineEnd === -1 ? undefined : lineEnd).trim() !== "") {
    return { ok: false, reason: "unclosed" };
  }
  return { ok: true, block: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

export type FrontmatterParse =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: "yaml"; line: number | null; reason: string }
  | { ok: false; kind: "shape" };

/** The header as YAML, or why it is not. Lines count from the top of the file. */
export function parseFrontmatterBlock(block: string): FrontmatterParse {
  let value: unknown;
  try {
    // "error" keeps the library from printing warnings (an unknown tag, say)
    // into the server log; errors are thrown either way.
    value = parse(block, { logLevel: "error" });
  } catch (error) {
    const first = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "yaml",
      // The header starts on the second line of the file.
      line: typeof first === "number" ? first + 1 : null,
      reason: message.split("\n")[0].replace(/\s+at line \d+, column \d+:?$/, ""),
    };
  }
  // A header with nothing in it is a mapping with nothing in it: the missing
  // fields are then reported by name instead of as a shape problem.
  if (value === null || value === undefined) return { ok: true, data: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, kind: "shape" };
  return { ok: true, data: value as Record<string, unknown> };
}

/**
 * Every plain value of a header as text, under a lowercased key; null when the
 * header is not YAML, so the caller can fall back to reading it line by line.
 * Lists and nested mappings are left out - nothing reading a skill's header
 * wants one.
 */
export function readFrontmatterStrings(block: string): Record<string, string> | null {
  const parsed = parseFrontmatterBlock(block);
  if (!parsed.ok) return null;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (typeof value === "string") strings[key.toLowerCase()] = value.trim();
    else if (typeof value === "number" || typeof value === "boolean") strings[key.toLowerCase()] = String(value);
    else if (value === null) strings[key.toLowerCase()] = "";
  }
  return strings;
}
