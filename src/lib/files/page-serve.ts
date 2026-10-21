import { contentDisposition } from "@/lib/files/download-headers";
import { markForEditing, readPage } from "@/lib/files/html-source";
import { editingScript, PRINT_STYLE, printScript } from "@/lib/files/page-scripts";
import { pageContentType, sourceSha } from "@/lib/files/pages";

/**
 * How a page and the files beside it are served to the frame on screen - a
 * page of this workspace, or one a colleague shared.
 *
 * Every answer is sandboxed with no origin of its own, may not fetch anything,
 * and sends no referrer, so a page's scripts can neither reach the workspace
 * nor read its files and carry them off, and the key in its address never
 * leaves in a Referer. `edit` and `pick` serve a copy marked for pointing at
 * blocks with the page's own scripts off - `pick` without changing words -
 * and `print` a copy that gets ready and opens the print dialog.
 */

export type PageMode = "view" | "edit" | "pick" | "print";

export function pageModeOf(requested: string | null, html: boolean, allowed: PageMode[] = ["edit", "pick", "print"]): PageMode {
  if (!html) return "view";
  return requested === "edit" || requested === "pick" || requested === "print" ? (allowed.includes(requested) ? requested : "view") : "view";
}

function policy(mode: PageMode, nonce: string): string {
  const marked = mode === "edit" || mode === "pick";
  const sandbox = marked ? "sandbox allow-scripts" : "sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox";
  const scripts = marked ? `; script-src 'nonce-${nonce}'` : "";
  return `${sandbox}; connect-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'${scripts}`;
}

export function pageHeaders(fileName: string, mode: PageMode, nonce: string): Record<string, string> {
  return {
    "Content-Type": pageContentType(fileName),
    "Content-Disposition": contentDisposition("inline", fileName.split("/").pop() || "file"),
    "Content-Security-Policy": policy(mode, nonce),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/** The copy of a page that is served in a marked or printing mode. */
export function pageCopy(source: string, mode: Exclude<PageMode, "view">, nonce: string, fileName: string): string {
  if (mode === "edit" || mode === "pick") {
    return markForEditing(source, readPage(source), editingScript(sourceSha(source), nonce, { edit: mode === "edit" }));
  }
  const title = (fileName.split("/").pop() || "page").replace(/\.html?$/i, "");
  return markForEditing(source, { elements: [], bodyEnd: readPage(source).bodyEnd }, `${PRINT_STYLE}${printScript(title)}`);
}

export function pageNotFound(): Response {
  return new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export function pageLinkExpired(): Response {
  return new Response("This link has expired. Open the page again.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
