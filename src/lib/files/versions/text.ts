import { comparisonOf, extensionOf } from "@/lib/files/versions/rules";
import { listZip, readZipEntry, type ZipEntry } from "@/lib/skills/zip-reader";

/**
 * The text of one version, for showing and comparing.
 *
 * A text file is shown as it is. An office document is a zip of XML, and what a
 * person compares in it is the words, so those are read out: a paragraph per
 * line, a table row per line with its cells side by side, a slide or a sheet
 * under a heading of its own. Formatting is not compared - a document whose
 * only change is a bold word reads here as unchanged, which the screen says.
 *
 * The XML is read in one pass, tag by tag (xmlTokens), never with patterns that
 * look ahead for a closing tag: a document can come from anywhere - the agent
 * downloads files - and a part with thousands of tags that never close made
 * those patterns quadratic, enough to hang the workspace on opening its history.
 * scripts/bin/eggent-history reads documents the same way; the test holds the
 * two equal.
 */

export const MAX_SHOWN_CHARS = 2_000_000;
// Per part of a document, before anything is inflated: an entry that claims
// more than this is not a page of text.
const MAX_PART_BYTES = 16 * 1024 * 1024;

export interface ExtractedText {
  kind: "text" | "extracted" | "none";
  text: string;
  truncated?: boolean;
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

export function decodeXml(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10));
    return ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[lower] ?? whole;
  });
}

type XmlToken =
  | { type: "open"; name: string; attrs: string; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; text: string };

/** Every tag and every run of text, in order, each character looked at a bounded number of times. */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    if (lt < 0) {
      yield { type: "text", text: xml.slice(at) };
      return;
    }
    if (lt > at) yield { type: "text", text: xml.slice(at, lt) };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      at = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      // CDATA is text as it stands; marked so the decoder leaves it alone.
      yield { type: "text", text: (end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)).replace(/&/g, "&amp;") };
      at = end < 0 ? xml.length : end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    at = gt + 1;
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("?") || inner.startsWith("!")) continue;
    if (inner.startsWith("/")) {
      yield { type: "close", name: inner.slice(1).trim() };
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    yield { type: "open", name, attrs: space < 0 ? "" : body.slice(space + 1), selfClosing };
  }
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]) : undefined;
}

async function readPart(data: Buffer, entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.path === name && candidate.kind === "file");
  if (!entry || entry.size > MAX_PART_BYTES) return null;
  return (await readZipEntry(data, entry)).toString("utf8");
}

/**
 * Paragraphs as lines, table rows as one line with their cells joined: Word
 * (`w:`) and the same shape is reused for nothing else. Text inside a tracked
 * deletion is not read: it is not in the document any more.
 */
function wordText(xml: string): string {
  const lines: string[] = [];
  // A table inside a table cell writes its rows into that cell.
  const tables: Array<{ row: string[] | null; cell: string[] | null }> = [];
  // A paragraph inside a paragraph (a text box) is read on its own and the outer one goes on after it.
  const paragraphs: string[] = [];
  let inText = false;
  let deleted = 0;
  const emitParagraph = (text: string) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(text);
    else lines.push(text);
  };
  const append = (text: string) => {
    if (paragraphs.length > 0 && deleted === 0) paragraphs[paragraphs.length - 1] += text;
  };
  for (const token of xmlTokens(xml)) {
    if (token.type === "text") {
      if (inText) append(decodeXml(token.text));
      continue;
    }
    const name = token.name;
    if (token.type === "open") {
      if (name === "w:del") {
        if (!token.selfClosing) deleted += 1;
      } else if (name === "w:p") {
        if (token.selfClosing) emitParagraph("");
        else paragraphs.push("");
      } else if (name === "w:t") {
        inText = !token.selfClosing;
      } else if (name === "w:tab") {
        append("\t");
      } else if (name === "w:br" || name === "w:cr") {
        append("\n");
      } else if (name === "w:tbl" && !token.selfClosing) {
        tables.push({ row: null, cell: null });
      } else if (name === "w:tr" && !token.selfClosing) {
        const table = tables[tables.length - 1];
        if (table) table.row = [];
      } else if (name === "w:tc" && !token.selfClosing) {
        const table = tables[tables.length - 1];
        if (table) table.cell = [];
      }
      continue;
    }
    if (name === "w:del") deleted = Math.max(0, deleted - 1);
    else if (name === "w:t") inText = false;
    else if (name === "w:p") {
      const text = paragraphs.pop();
      if (text !== undefined) emitParagraph(text);
    } else if (name === "w:tc") {
      const table = tables[tables.length - 1];
      if (table?.cell && table.row) table.row.push(table.cell.join(" ").trim());
      if (table) table.cell = null;
    } else if (name === "w:tr") {
      const table = tables[tables.length - 1];
      if (table?.row && table.row.some(Boolean)) {
        const line = table.row.join(" | ");
        const outer = tables[tables.length - 2];
        if (outer?.cell) outer.cell.push(line);
        else lines.push(line);
      }
      if (table) table.row = null;
    } else if (name === "w:tbl") {
      tables.pop();
    }
  }
  return lines.join("\n");
}

/** OpenDocument text: headings and paragraphs as lines, every bit of text inside them. */
function openDocumentText(xml: string): string {
  const lines: string[] = [];
  let paragraph: string | null = null;
  let depth = 0;
  for (const token of xmlTokens(xml)) {
    if (token.type === "text") {
      if (paragraph !== null) paragraph += decodeXml(token.text);
      continue;
    }
    if (token.type === "open") {
      if (token.name === "text:p" || token.name === "text:h") {
        if (token.selfClosing) {
          if (paragraph === null) lines.push("");
        } else if (paragraph === null) {
          paragraph = "";
          depth = 1;
        } else {
          depth += 1;
        }
      } else if (paragraph !== null) {
        if (token.name === "text:tab") paragraph += "\t";
        else if (token.name === "text:line-break") paragraph += "\n";
        else if (token.name === "text:s") paragraph += " ";
      }
      continue;
    }
    if ((token.name === "text:p" || token.name === "text:h") && paragraph !== null) {
      depth -= 1;
      if (depth === 0) {
        lines.push(paragraph);
        paragraph = null;
      }
    }
  }
  return lines.join("\n");
}

/** A slide's paragraphs (`a:p`), the non-empty ones. */
function slideText(xml: string): string[] {
  const lines: string[] = [];
  let paragraph: string | null = null;
  let inText = false;
  for (const token of xmlTokens(xml)) {
    if (token.type === "text") {
      if (inText && paragraph !== null) paragraph += decodeXml(token.text);
      continue;
    }
    if (token.type === "open") {
      if (token.name === "a:p") paragraph = token.selfClosing ? null : "";
      else if (token.name === "a:t") inText = !token.selfClosing;
      else if (token.name === "a:tab" && paragraph !== null) paragraph += "\t";
      else if (token.name === "a:br" && paragraph !== null) paragraph += "\n";
      continue;
    }
    if (token.name === "a:t") inText = false;
    else if (token.name === "a:p") {
      if (paragraph !== null && paragraph.trim()) lines.push(paragraph);
      paragraph = null;
    }
  }
  return lines;
}

function numberedParts(entries: ZipEntry[], pattern: RegExp): string[] {
  return entries
    .map((entry) => entry.path)
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}

/** The shared strings of a workbook: the text of each `si`, phonetic hints left out. */
function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const token of xmlTokens(xml)) {
    if (token.type === "text") {
      if (inText && phonetic === 0 && current !== null) current += decodeXml(token.text);
      continue;
    }
    if (token.type === "open") {
      if (token.name === "si") {
        if (token.selfClosing) strings.push("");
        else current = "";
      } else if (token.name === "t") inText = !token.selfClosing;
      else if (token.name === "rPh" && !token.selfClosing) phonetic += 1;
      continue;
    }
    if (token.name === "t") inText = false;
    else if (token.name === "rPh") phonetic = Math.max(0, phonetic - 1);
    else if (token.name === "si") {
      if (current !== null) strings.push(current);
      current = null;
    }
  }
  return strings;
}

/** One sheet: a line per row with values, each cell as `column: value`, a formula after its value. */
function sheetLines(xml: string, shared: string[]): string[] {
  const lines: string[] = [];
  let row: { number: string; cells: string[] } | null = null;
  let cell: { column: string; type?: string; value: string; formula: string; inline: string } | null = null;
  let reading: "v" | "f" | "t" | null = null;
  const finishCell = () => {
    if (!row || !cell) return;
    let value = "";
    if (cell.type === "s") value = cell.value ? shared[Number(cell.value)] ?? "" : "";
    else if (cell.type === "inlineStr") value = cell.inline;
    else if (cell.type === "b") value = cell.value === "1" ? "TRUE" : cell.value === "0" ? "FALSE" : "";
    else value = cell.value;
    if (cell.formula) value = value ? `${value} (=${cell.formula})` : `=${cell.formula}`;
    if (value !== "") row.cells.push(`${cell.column}: ${value.replace(/\n/g, " ")}`);
    cell = null;
  };
  for (const token of xmlTokens(xml)) {
    if (token.type === "text") {
      if (!cell || !reading) continue;
      const text = decodeXml(token.text);
      if (reading === "v") cell.value += text;
      else if (reading === "f") cell.formula += text;
      else cell.inline += text;
      continue;
    }
    if (token.type === "open") {
      if (token.name === "row") {
        row = { number: attribute(token.attrs, "r") ?? "", cells: [] };
        if (token.selfClosing) row = null;
      } else if (token.name === "c") {
        const reference = attribute(token.attrs, "r") ?? "";
        cell = { column: /^[A-Z]+/.exec(reference)?.[0] ?? "", type: attribute(token.attrs, "t"), value: "", formula: "", inline: "" };
        if (token.selfClosing) finishCell();
      } else if (cell && (token.name === "v" || token.name === "f" || token.name === "t")) {
        reading = token.selfClosing ? null : token.name;
      }
      continue;
    }
    if (token.name === "v" || token.name === "f" || token.name === "t") reading = null;
    else if (token.name === "c") finishCell();
    else if (token.name === "row") {
      if (row && row.cells.length > 0) lines.push(`${row.number}. ${row.cells.join(" | ")}`);
      row = null;
    }
  }
  return lines;
}

/** Excel: each sheet under its name, in the workbook's order. */
async function workbookText(data: Buffer): Promise<string | null> {
  const entries = listZip(data);
  const sharedXml = await readPart(data, entries, "xl/sharedStrings.xml");
  const shared = sharedXml ? sharedStrings(sharedXml) : [];
  const targets = new Map<string, string>();
  for (const token of xmlTokens((await readPart(data, entries, "xl/_rels/workbook.xml.rels")) ?? "")) {
    if (token.type !== "open" || token.name !== "Relationship") continue;
    const id = attribute(token.attrs, "Id");
    const target = attribute(token.attrs, "Target");
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const names = new Map<string, string>();
  const order: string[] = [];
  for (const token of xmlTokens((await readPart(data, entries, "xl/workbook.xml")) ?? "")) {
    if (token.type !== "open" || token.name !== "sheet") continue;
    const id = attribute(token.attrs, "r:id");
    const target = id ? targets.get(id) : undefined;
    if (target) {
      names.set(target, attribute(token.attrs, "name") ?? "");
      order.push(target);
    }
  }
  const sheets = order.length > 0 ? order : numberedParts(entries, /^xl\/worksheets\/sheet\d+\.xml$/);
  if (sheets.length === 0) return null;
  const lines: string[] = [];
  for (const [index, part] of sheets.entries()) {
    const xml = await readPart(data, entries, part);
    if (xml === null) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`## ${names.get(part) || `Sheet${index + 1}`}`);
    lines.push(...sheetLines(xml, shared));
  }
  return lines.join("\n");
}

/** PowerPoint: each slide under its number. */
async function presentationText(data: Buffer, labels: { slide: string }): Promise<string | null> {
  const entries = listZip(data);
  const slides = numberedParts(entries, /^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) return null;
  const lines: string[] = [];
  for (const [index, name] of slides.entries()) {
    const xml = await readPart(data, entries, name);
    if (xml === null) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`## ${labels.slide} ${index + 1}`);
    lines.push(...slideText(xml));
  }
  return lines.join("\n");
}

function cap(text: string, kind: ExtractedText["kind"]): ExtractedText {
  if (text.length <= MAX_SHOWN_CHARS) return { kind, text };
  return { kind, text: text.slice(0, MAX_SHOWN_CHARS), truncated: true };
}

export async function extractVersionText(name: string, content: Buffer, labels: { slide: string } = { slide: "Slide" }): Promise<ExtractedText> {
  const comparison = comparisonOf(name);
  if (comparison === "text") {
    const text = content.toString("utf8").replace(/^﻿/, "");
    return cap(text, "text");
  }
  if (comparison === "none") return { kind: "none", text: "" };
  try {
    const extension = extensionOf(name);
    let text: string | null = null;
    if (extension === "docx") {
      const entries = listZip(content);
      const xml = await readPart(content, entries, "word/document.xml");
      text = xml === null ? null : wordText(xml);
    } else if (extension === "odt") {
      const entries = listZip(content);
      const xml = await readPart(content, entries, "content.xml");
      text = xml === null ? null : openDocumentText(xml);
    } else if (extension === "xlsx") {
      text = await workbookText(content);
    } else if (extension === "pptx") {
      text = await presentationText(content, labels);
    }
    if (text === null) return { kind: "none", text: "" };
    return cap(text, "extracted");
  } catch {
    // Not a document after all, or a damaged one: nothing to compare, but every version can still be downloaded.
    return { kind: "none", text: "" };
  }
}
