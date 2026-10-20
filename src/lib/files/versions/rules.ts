/**
 * Which files get a history, and how two of their versions are compared.
 *
 * Client-safe: the history panel asks the same questions about a file name as
 * the server that records it, and the two must not disagree about whether a
 * comparison is possible.
 *
 * History is for documents and text somebody works on. A picture, a recording,
 * an archive or a PDF is left out: the history counts against the workspace's
 * disk, and a report regenerated every morning as a 2 MB PDF would fill a small
 * plan by itself within a month while nobody ever compared two of them.
 */

export type VersionedKind = "text" | "document";

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "asciidoc", "org", "tex", "bib",
  "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "xml", "html", "htm", "xhtml", "svg", "css", "scss", "sass", "less",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro",
  "py", "ipynb", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "r", "lua", "pl", "pm", "dart", "scala",
  "ex", "exs", "erl", "hrl", "hs", "ml", "mli", "clj", "edn", "graphql", "gql", "proto", "tf",
  "srt", "vtt",
]);

/** Office documents: kept whole, compared by the text inside them where that can be read. */
const DOCUMENT_EXTENSIONS = new Set(["docx", "xlsx", "pptx", "odt", "rtf"]);

/** The documents whose text can be read out for a comparison. */
const EXTRACTED_EXTENSIONS = new Set(["docx", "xlsx", "pptx", "odt"]);

/** Written as running text, so a change reads best as words struck out and words put in. */
const PROSE_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "asciidoc", "org", "tex", "srt", "vtt",
  "docx", "pptx", "odt",
]);

/** Generated, rewritten whole by a tool, and never compared by a person. */
const EXCLUDED_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "cargo.lock", "poetry.lock", "composer.lock", "gemfile.lock", "pipfile.lock", "uv.lock",
  ".ds_store", "thumbs.db",
]);

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  // ".gitignore" has a name and no extension.
  return dot > 0 ? base.slice(dot + 1) : "";
}

function baseNameOf(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

/**
 * Whether a file of this name gets a history: as text, as a document, `sniff`
 * when it has no extension and only its contents can say (a README, a
 * Makefile), or null.
 */
export function versionedKindOf(name: string): VersionedKind | "sniff" | null {
  const base = baseNameOf(name);
  const lower = base.toLowerCase();
  if (!base || EXCLUDED_NAMES.has(lower)) return null;
  // Office's lock file beside an open document, editors' backups, anything temporary.
  if (lower.startsWith("~$") || lower.startsWith(".~lock.") || lower.endsWith("~") || lower.endsWith(".tmp") || lower.endsWith(".swp")) return null;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.css") || lower.endsWith(".map") || lower.endsWith(".log")) return null;
  const extension = extensionOf(lower);
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return extension ? null : "sniff";
}

/** How two versions of the file are compared: as they are, by the text read out of them, or not at all. */
export function comparisonOf(name: string): "text" | "extracted" | "none" {
  const kind = versionedKindOf(name);
  if (kind === "text" || kind === "sniff") return "text";
  if (kind === "document") return EXTRACTED_EXTENSIONS.has(extensionOf(name)) ? "extracted" : "none";
  return "none";
}

/** Whether a comparison should open as running text rather than as lines. */
export function prefersProse(name: string): boolean {
  return PROSE_EXTENSIONS.has(extensionOf(name));
}

/**
 * A document a command may have rewritten, worth a version even when it has no
 * history yet. A script that touches code or data files has no such claim: a
 * history of every file a build step rewrites would fill the disk with copies
 * nobody looks at, so those get one only once somebody edits them by hand.
 */
export function isDocumentForScan(name: string): boolean {
  const extension = extensionOf(name);
  return DOCUMENT_EXTENSIONS.has(extension) || PROSE_EXTENSIONS.has(extension) || extension === "csv" || extension === "html" || extension === "htm";
}

/** The history key of a file the dashboard names by project and path: where it sits under the projects folder. */
export function historyKeyOf(projectId: string, filePath: string): string {
  const clean = filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return !projectId || projectId === "none" ? clean : `${projectId}/${clean}`;
}
