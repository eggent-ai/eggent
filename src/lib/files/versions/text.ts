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
 */

export const MAX_SHOWN_CHARS = 2_000_000;
// Per part of a document, before anything is inflated: an entry that claims
// more than this is not a page of text.
const MAX_PART_BYTES = 40 * 1024 * 1024;

export interface ExtractedText {
  kind: "text" | "extracted" | "none";
  text: string;
  truncated?: boolean;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

async function readPart(data: Buffer, entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find((candidate) => candidate.path === name && candidate.kind === "file");
  if (!entry || entry.size > MAX_PART_BYTES) return null;
  return (await readZipEntry(data, entry)).toString("utf8");
}

/** The text runs of one paragraph-like element, with tabs and breaks kept as such. */
function runsOf(xml: string, textTag: string): string {
  let text = "";
  const pattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|<(?:w:tab|a:tab|text:tab)\\b[^>]*/>|<(?:w:br|a:br|text:line-break)\\b[^>]*/>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else if (/tab/.test(match[0])) text += "\t";
    else text += "\n";
  }
  return text;
}

/** Word: paragraphs as lines; a table's row as one line, its cells joined. */
async function docxText(data: Buffer): Promise<string | null> {
  const entries = listZip(data);
  const xml = await readPart(data, entries, "word/document.xml");
  if (xml === null) return null;
  const body = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
  const lines: string[] = [];
  // Tables first, so their paragraphs are not read twice.
  const parts = body.split(/(<w:tbl\b[\s\S]*?<\/w:tbl>)/g);
  for (const part of parts) {
    if (part.startsWith("<w:tbl")) {
      for (const row of part.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) =>
          [...cell[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => runsOf(p[0], "w:t")).join(" ").trim()
        );
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      }
      continue;
    }
    for (const paragraph of part.matchAll(/<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)) {
      lines.push(runsOf(paragraph[0], "w:t"));
    }
  }
  return lines.join("\n");
}

/** OpenDocument text: headings and paragraphs as lines. */
async function odtText(data: Buffer): Promise<string | null> {
  const entries = listZip(data);
  const xml = await readPart(data, entries, "content.xml");
  if (xml === null) return null;
  const lines: string[] = [];
  for (const paragraph of xml.matchAll(/<text:(p|h)\b[^>]*\/>|<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\2>/g)) {
    const inner = paragraph[3] ?? "";
    const text = decodeXml(
      inner
        .replace(/<text:tab\b[^>]*\/>/g, "\t")
        .replace(/<text:line-break\b[^>]*\/>/g, "\n")
        .replace(/<text:s\b[^>]*\/>/g, " ")
        .replace(/<[^>]+>/g, "")
    );
    lines.push(text);
  }
  return lines.join("\n");
}

function numberedParts(entries: ZipEntry[], pattern: RegExp): string[] {
  return entries
    .map((entry) => entry.path)
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}

/** PowerPoint: each slide under its number, a paragraph per line. */
async function pptxText(data: Buffer, labels: { slide: string }): Promise<string | null> {
  const entries = listZip(data);
  const slides = numberedParts(entries, /^ppt\/slides\/slide\d+\.xml$/);
  if (slides.length === 0) return null;
  const lines: string[] = [];
  for (const [index, name] of slides.entries()) {
    const xml = await readPart(data, entries, name);
    if (xml === null) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`## ${labels.slide} ${index + 1}`);
    for (const paragraph of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const text = runsOf(paragraph[0], "a:t");
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join("\n");
}

function columnOf(reference: string): string {
  return /^[A-Z]+/.exec(reference)?.[0] ?? "";
}

/** Excel: each sheet under its name, a row per line, cells by column. */
async function xlsxText(data: Buffer): Promise<string | null> {
  const entries = listZip(data);
  const shared: string[] = [];
  const sharedXml = await readPart(data, entries, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const item of sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
      shared.push(runsOf(item[0].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""), "t"));
    }
  }
  const names = new Map<string, string>();
  const workbook = await readPart(data, entries, "xl/workbook.xml");
  const relations = await readPart(data, entries, "xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  for (const relation of relations?.matchAll(/<Relationship\b[^>]*>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(relation[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(relation[0])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const order: string[] = [];
  for (const sheet of workbook?.matchAll(/<sheet\b[^>]*>/g) ?? []) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(sheet[0])?.[1] ?? "");
    const id = /\br:id="([^"]+)"/.exec(sheet[0])?.[1];
    const target = id ? targets.get(id) : undefined;
    if (target) {
      names.set(target, name);
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
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNumber = /\br="(\d+)"/.exec(row[1])?.[1] ?? "";
      const cells: string[] = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1];
        const inner = cell[2] ?? "";
        const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1] ?? "";
        const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = runsOf(inner, "t");
        else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
        else if (raw !== undefined) value = decodeXml(raw);
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        if (formula) value = value ? `${value} (=${decodeXml(formula)})` : `=${decodeXml(formula)}`;
        if (value !== "") cells.push(`${columnOf(reference)}: ${value.replace(/\n/g, " ")}`);
      }
      if (cells.length > 0) lines.push(`${rowNumber}. ${cells.join(" | ")}`);
    }
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
    const text =
      extension === "docx" ? await docxText(content)
      : extension === "xlsx" ? await xlsxText(content)
      : extension === "pptx" ? await pptxText(content, labels)
      : extension === "odt" ? await odtText(content)
      : null;
    if (text === null) return { kind: "none", text: "" };
    return cap(text, "extracted");
  } catch {
    // Not a document after all, or a damaged one: nothing to compare, but every version can still be downloaded.
    return { kind: "none", text: "" };
  }
}
