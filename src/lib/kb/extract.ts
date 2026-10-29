import { extractVersionText } from "@/lib/files/versions/text";
import { comparisonOf, extensionOf } from "@/lib/files/versions/rules";
import { loadPdf } from "@/lib/memory/loaders/pdf-loader";

/**
 * The words in one file of a shared project, for the search over it.
 *
 * Office documents and text are read the way the file history reads them
 * (extractVersionText), a PDF by the loader memory uses. What comes out is a
 * list of sections, each with a place a person can find again: a page of a
 * PDF, a slide, a sheet, or the first line of a passage in a text file.
 *
 * Which files may be read at all is not decided here: the index only hands
 * over files a public share is allowed to see (publicPathAllowed).
 */

export interface ExtractedSection {
  /** Where in the file: "page 3", "Slide 2", a sheet's name, or empty for running text. */
  place: string;
  text: string;
  /**
   * For running text, what a line of `text` is in the file: a line of a text
   * file, a paragraph of a document. Each passage is then placed by its first one.
   */
  lines?: "line" | "paragraph";
}

/** Whether a file of this name has text the search can read. */
export function kbReadable(name: string): boolean {
  return extensionOf(name) === "pdf" || comparisonOf(name) !== "none";
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

/** Sections under the "## Name" headings extractVersionText writes for sheets and slides. */
function byHeadings(text: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      current = { place: line.slice(3).trim(), text: "" };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { place: "", text: "" };
      sections.push(current);
    }
    current.text += current.text ? `\n${line}` : line;
  }
  return sections.filter((section) => section.text.trim());
}

/**
 * The text of a file, as sections; an empty list when there is none to read.
 * `absolute` is only used for a PDF, whose loader opens the file itself.
 */
export async function extractKbText(name: string, absolute: string, content: Buffer): Promise<ExtractedSection[]> {
  const extension = extensionOf(name);
  if (extension === "pdf") {
    try {
      const loaded = await loadPdf(absolute);
      // The loader puts a blank line after every page and none inside one.
      return loaded.text
        .split("\n\n")
        .map((text, index) => ({ place: `page ${index + 1}`, text: text.trim() }))
        .filter((section) => section.text);
    } catch {
      return [];
    }
  }
  const comparison = comparisonOf(name);
  if (comparison === "none") return [];
  if (comparison === "text" && looksBinary(content)) return [];
  const extracted = await extractVersionText(name, content);
  if (extracted.kind === "none" || !extracted.text.trim()) return [];
  if (extension === "xlsx" || extension === "pptx") return byHeadings(extracted.text);
  return [{ place: "", text: extracted.text, lines: comparison === "text" ? "line" : "paragraph" }];
}
