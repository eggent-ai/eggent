import type { NextRequest } from "next/server";
import { applyTextEdits } from "@/lib/files/html-source";
import { parseTextEdits } from "@/lib/files/page-blocks";
import { MAX_PAGE_BYTES, sourceSha } from "@/lib/files/pages";
import { fetchSharedFile, writeSharedFile } from "@/lib/shares/client";
import { NO_STORE, shareIdOf, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/**
 * Words changed on a shared page, written into its owner's file where they
 * came from:
 *
 *   POST /api/shares/<id>/page-edit  { sha, edits: [{ el, slot, was, text }] }  ->  { sha, changed }
 *
 * The page on screen must have been made from the file as it is now (`sha`),
 * each piece must still read what the person saw, and the file is written
 * only onto that very version - the service refuses it otherwise, and refuses
 * anybody it is not shared with to edit.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const id = shareIdOf((await params).id);
  if (!id) return Response.json({ error: "There is no such shared file.", code: "noShare" }, { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { sha?: unknown; edits?: unknown } | null;
  const edits = parseTextEdits(body?.edits);
  if (!edits) return Response.json({ error: "A change is not well formed.", code: "badRequest" }, { status: 400, headers: NO_STORE });
  if (!edits.length) return Response.json({ error: "Nothing to change.", code: "badRequest" }, { status: 400, headers: NO_STORE });
  try {
    const file = await fetchSharedFile(id);
    if (file.data.length > MAX_PAGE_BYTES) return Response.json({ error: "The page is too large to change here.", code: "tooLarge" }, { status: 413, headers: NO_STORE });
    const source = file.data.toString("utf8");
    const baseSha = sourceSha(source);
    if (baseSha !== body?.sha) return Response.json({ error: "The file has changed since the page was shown.", code: "changed" }, { status: 409, headers: NO_STORE });
    const applied = applyTextEdits(source, edits);
    if (!applied.ok) return Response.json({ error: "This text is not where the page shows it.", code: applied.reason }, { status: 409, headers: NO_STORE });
    if (!applied.changed) return Response.json({ sha: baseSha, changed: 0 }, { headers: NO_STORE });
    // The hash of the bytes as they came: what the service compares the version with.
    const written = await writeSharedFile(id, { baseSha: file.sha256, data: Buffer.from(applied.source, "utf8") });
    return Response.json({ sha: written.sha256, changed: applied.changed }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
