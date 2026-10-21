import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { labelOf, readPage } from "@/lib/files/html-source";
import { MAX_PAGE_BYTES, readScopeFile, scopeFile, sourceSha } from "@/lib/files/pages";

/**
 * A block picked on a page, as it is in the file:
 *
 *   GET /api/files/page-element?project=<id|none>&path=<file>&sha=<hash>&el=<n>
 *     ->  { label, startLine, endLine, start, end, source }
 *
 * `sha` is the hash of the text the page on screen was made from; when the
 * file has changed since, the answer is 409 and the screen shows it afresh.
 */
const MAX_SOURCE_CHARS = 4000;

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError(failure, guardStatus(failure));
  const params = req.nextUrl.searchParams;
  const file = await scopeFile(params.get("project")?.trim() || "", params.get("path")?.trim() || "");
  const n = Number(params.get("el"));
  if (!file || !Number.isInteger(n) || n < 0) return Response.json({ error: "No such block.", code: "noElement" }, { status: 404 });
  const bytes = await readScopeFile(file, MAX_PAGE_BYTES);
  if (!Buffer.isBuffer(bytes)) return Response.json({ error: "The file cannot be read.", code: "unreadable" }, { status: 404 });
  const source = bytes.toString("utf8");
  if (sourceSha(source) !== params.get("sha")) return Response.json({ error: "The file has changed since the page was shown.", code: "changed" }, { status: 409 });
  const element = readPage(source).elements[n];
  if (!element) return Response.json({ error: "No such block.", code: "noElement" }, { status: 404 });
  const text = source.slice(element.start, element.end);
  return Response.json(
    {
      label: labelOf(element),
      startLine: element.startLine,
      endLine: element.endLine,
      start: element.start,
      end: element.end,
      source: text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}…` : text,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
