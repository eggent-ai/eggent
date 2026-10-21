import { parse, type DefaultTreeAdapterMap } from "parse5";

/**
 * A page's source, read the way a browser reads it, with every element and
 * every piece of text tied to the place in the file it came from.
 *
 * This is what lets the person point at a block on the rendered page and the
 * file be touched only there: a word changed on the page replaces exactly the
 * characters of that text in the source, and the rest of the file stays byte
 * for byte what it was - the agent's formatting, comments and all. Nothing is
 * ever re-serialised from a tree.
 *
 * Elements are numbered in document order, HTML elements only: what is inside
 * an <svg> or <math> keeps its own syntax (a self-closing tag means something
 * there) and is left as it is. The same numbering is computed for the copy
 * shown on screen and for the edit that comes back, from the same text - which
 * is why every request about a page carries the hash of the text it was made on.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

const HTML_NS = "http://www.w3.org/1999/xhtml";
// Text a person cannot change by typing on the page: code, and form controls.
const UNEDITABLE = new Set(["script", "style", "template", "noscript", "textarea", "select", "option", "optgroup", "iframe", "object"]);
const KEEPS_WHITESPACE = new Set(["pre", "textarea", "listing", "plaintext"]);

export interface PageElement {
  n: number;
  tag: string;
  start: number;
  end: number;
  /** Where the start tag's closing ">" is. */
  startTagClose: number;
  startLine: number;
  endLine: number;
  node: Element;
}

export interface PageSource {
  elements: PageElement[];
  /** Where the body's end tag begins, if the file has one. */
  bodyEnd: number | null;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === "#text";
}

export function readPage(source: string): PageSource {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const elements: PageElement[] = [];
  let bodyEnd: number | null = null;
  const walk = (node: Node) => {
    const children = "childNodes" in node ? node.childNodes : [];
    for (const child of children) {
      if (!isElement(child)) continue;
      // Foreign content keeps its own rules; nothing in it is numbered.
      if (child.namespaceURI !== HTML_NS) continue;
      const location = child.sourceCodeLocation;
      if (child.tagName === "body" && location?.endTag) bodyEnd = location.endTag.startOffset;
      if (location?.startTag && source[location.startTag.endOffset - 1] === ">") {
        elements.push({
          n: elements.length,
          tag: child.tagName,
          start: location.startTag.startOffset,
          end: location.endTag?.endOffset ?? location.endOffset,
          startTagClose: location.startTag.endOffset - 1,
          startLine: location.startLine,
          endLine: location.endTag?.endLine ?? location.endLine,
          node: child,
        });
      }
      // A <template>'s content is inert and never shown; it is not walked.
      walk(child);
    }
  };
  walk(document);
  return { elements, bodyEnd };
}

/**
 * The copy of a page shown for pointing at blocks: every numbered element
 * carries `data-eggent-el`, and `tail` (the script that talks to the screen)
 * goes just before the body ends. The file itself is never written this way.
 */
export function markForEditing(source: string, page: PageSource, tail: string): string {
  const inserts: Array<{ at: number; text: string }> = page.elements.map((element) => ({
    at: element.startTagClose,
    text: ` data-eggent-el="${element.n}"`,
  }));
  inserts.push({ at: page.bodyEnd ?? source.length, text: tail });
  inserts.sort((a, b) => a.at - b.at);
  let out = "";
  let from = 0;
  for (const insert of inserts) {
    out += source.slice(from, insert.at) + insert.text;
    from = insert.at;
  }
  return out + source.slice(from);
}

function within(element: Element, tags: Set<string>): boolean {
  for (let node: Node | null = element; node && isElement(node); node = node.parentNode as Node | null) {
    if (tags.has(node.tagName)) return true;
  }
  return false;
}

/** A short name for a block, the way a person would point at it: "section.hero", "h2", "a#buy". */
export function labelOf(element: PageElement): string {
  const attrs = element.node.attrs;
  const id = attrs.find((attr) => attr.name === "id")?.value.trim();
  const className = attrs.find((attr) => attr.name === "class")?.value.trim().split(/\s+/)[0];
  return `${element.tag}${id ? `#${id}` : className ? `.${className}` : ""}`;
}

export interface TextEdit {
  /** The element, by its number. */
  el: number;
  /**
   * Which gap among its children: the number of children that are not text
   * (elements, comments) before it. A browser and the file agree on these
   * whatever typing did to the text nodes in between.
   */
  slot: number;
  /** What that text was when the person began typing ("" for a gap with no text) - checked against the file. */
  was: string;
  text: string;
}

/** The text in a gap of an element, and where in the source that gap is. */
function gapOf(element: Element, slot: number): { node: TextNode | null; at: number | null } {
  let seen = 0;
  let after: number | null = element.sourceCodeLocation?.startTag?.endOffset ?? null;
  for (const child of element.childNodes) {
    if (isText(child)) {
      if (seen === slot) return { node: child, at: null };
      continue;
    }
    if (seen === slot) return { node: null, at: after };
    seen += 1;
    after = child.sourceCodeLocation?.endOffset ?? null;
  }
  return { node: null, at: seen === slot ? after : null };
}

export type EditRefusal = "noElement" | "noText" | "mismatch" | "uneditable" | "overlap";

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Words changed on the page, put into the file where they came from. Each edit
 * names a piece of text by its element and place; the piece must still read
 * what the person saw, or nothing is written. Outside <pre> the whitespace
 * around the text in the file is kept, so the file's indentation survives.
 */
export function applyTextEdits(source: string, edits: TextEdit[]): { ok: true; source: string; changed: number } | { ok: false; reason: EditRefusal; edit?: TextEdit } {
  const page = readPage(source);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const edit of edits) {
    const element = page.elements[edit.el];
    if (!element || !Number.isInteger(edit.slot) || edit.slot < 0) return { ok: false, reason: "noElement", edit };
    if (within(element.node, UNEDITABLE)) return { ok: false, reason: "uneditable", edit };
    const gap = gapOf(element.node, edit.slot);
    if (!gap.node && gap.at === null) return { ok: false, reason: "noText", edit };
    if ((gap.node?.value ?? "") !== edit.was) return { ok: false, reason: "mismatch", edit };
    if (edit.text === edit.was) continue;
    const keepsWhitespace = within(element.node, KEEPS_WHITESPACE);
    if (!gap.node) {
      // Words typed where there were none: put in as typed.
      replacements.push({ start: gap.at as number, end: gap.at as number, text: escapeText(edit.text) });
      continue;
    }
    const location = gap.node.sourceCodeLocation;
    if (!location) return { ok: false, reason: "noText", edit };
    let text: string;
    if (keepsWhitespace) {
      text = escapeText(edit.text);
    } else {
      // Typing over a whole piece drops the file's line breaks and indentation
      // around it; they are put back unless the new text brings its own.
      const original = source.slice(location.startOffset, location.endOffset);
      const core = edit.text.replace(/^\s+|\s+$/g, "");
      const leading = /^\s*/.exec(edit.text)?.[0] || /^\s*/.exec(original)?.[0] || "";
      const trailing = core ? /\s*$/.exec(edit.text)?.[0] || (original.trim() ? /\s*$/.exec(original)?.[0] ?? "" : "") : "";
      text = `${leading}${escapeText(core)}${trailing}`;
    }
    replacements.push({ start: location.startOffset, end: location.endOffset, text });
  }
  replacements.sort((a, b) => b.start - a.start);
  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].end > replacements[index - 1].start || replacements[index].start === replacements[index - 1].start) return { ok: false, reason: "overlap" };
  }
  let out = source;
  for (const replacement of replacements) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
  }
  return { ok: true, source: out, changed: replacements.length };
}
