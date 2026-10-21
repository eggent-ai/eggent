import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { applyTextEdits, type TextEdit } from "@/lib/files/html-source";
import { MAX_PAGE_BYTES, readScopeFile, savePageAsPerson, scopeFile, sourceSha } from "@/lib/files/pages";

/**
 * Words changed on a page, written into its file where they came from:
 *
 *   POST /api/files/page-edit  { project, path, sha, edits: [{ el, slot, was, text }] }  ->  { sha }
 *
 * Only the characters of each piece of text are replaced; the rest of the file
 * stays as it was. The page on screen must have been made from the file as it
 * is now (`sha`), and each piece must still read what the person saw (`was`),
 * or nothing is written. It is the person's save: a version in the history.
 */
const MAX_EDITS = 200;
const MAX_TEXT = 20_000;

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError(failure, guardStatus(failure));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; sha?: unknown; edits?: unknown } | null;
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const file = await scopeFile(project, typeof body?.path === "string" ? body.path.trim() : "");
  if (!file) return Response.json({ error: "Not a file of this workspace.", code: "outside" }, { status: 403 });
  const raw = Array.isArray(body?.edits) ? body.edits : [];
  const edits: TextEdit[] = [];
  for (const entry of raw.slice(0, MAX_EDITS)) {
    const edit = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (!Number.isInteger(edit.el) || !Number.isInteger(edit.slot) || typeof edit.was !== "string" || typeof edit.text !== "string" || edit.text.length > MAX_TEXT) {
      return Response.json({ error: "A change is not well formed.", code: "badRequest" }, { status: 400 });
    }
    edits.push({ el: edit.el as number, slot: edit.slot as number, was: edit.was, text: edit.text });
  }
  if (!edits.length) return Response.json({ error: "Nothing to change.", code: "badRequest" }, { status: 400 });
  const bytes = await readScopeFile(file, MAX_PAGE_BYTES);
  if (!Buffer.isBuffer(bytes)) return Response.json({ error: "The file cannot be read.", code: "unreadable" }, { status: 404 });
  const source = bytes.toString("utf8");
  if (sourceSha(source) !== body?.sha) return Response.json({ error: "The file has changed since the page was shown.", code: "changed" }, { status: 409 });
  const applied = applyTextEdits(source, edits);
  if (!applied.ok) {
    return Response.json({ error: "This text is not where the page shows it.", code: applied.reason }, { status: 409 });
  }
  if (!applied.changed) return Response.json({ sha: sourceSha(source), changed: 0 }, { headers: { "Cache-Control": "no-store" } });
  const saved = await savePageAsPerson(project, file, applied.source);
  if (saved === "outside") return Response.json({ error: "Not a file of this workspace.", code: "outside" }, { status: 403 });
  if (saved === "tooLarge") return Response.json({ error: "The file is too large to keep a version of.", code: "tooLarge" }, { status: 409 });
  if (saved !== "saved") return Response.json({ error: "The file could not be written.", code: "failed" }, { status: 500 });
  return Response.json({ sha: sourceSha(applied.source), changed: applied.changed }, { headers: { "Cache-Control": "no-store" } });
}
