import fs from "node:fs/promises";
import type { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerTranslator } from "@/i18n/server";
import { getWorkDir } from "@/lib/storage/project-store";
import { projectFolderIsLink } from "@/lib/files/workspace-root";
import { captureAfter, captureBefore, versionTargetFor, writeFileInside } from "@/lib/files/versions/capture";
import { versionsEnabled } from "@/lib/files/versions/config";
import { getVersionStore } from "@/lib/files/versions/store";

/**
 * Bring an older version back:
 *
 *   POST /api/files/versions/restore  { project, path, n }  ->  { version }
 *
 * Nothing is lost by it. What the file holds now is kept first if the history
 * does not have it yet - a change made elsewhere a moment ago included - and the
 * restored text becomes a new version of its own ("restored from 5"), so going
 * back can itself be undone.
 */

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; n?: unknown } | null;
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const filePath = typeof body?.path === "string" ? body.path.trim() : "";
  const n = typeof body?.n === "number" ? body.n : Number.NaN;
  if (!project || !filePath || !Number.isInteger(n) || n < 1) return jsonError(t("api.error.projectIdAndFilePathRequired"), 400);
  if (!(await versionsEnabled())) return jsonError(t("files.history.off"), 409);
  if (await projectFolderIsLink(project)) return jsonError(t("api.error.invalidFilePath"), 403);

  const target = await versionTargetFor(project, filePath);
  if (!target) return jsonError(t("api.error.invalidFilePath"), 403);
  const store = getVersionStore();
  const entry = (await store.journal(target.key))?.versions.find((candidate) => candidate.n === n);
  if (!entry || entry.deleted) return jsonError(t("files.history.versionMissing"), 404);
  const content = await store.content(target.key, n);
  if (!content) return jsonError(t("files.history.versionMissing"), 404);

  try {
    await captureBefore(target.absolute);
    await writeFileInside(target.absolute, content, await fs.realpath(getWorkDir(project)));
  } catch {
    return jsonError(t("files.history.restoreFailed"), 409);
  }
  const version = await captureAfter(target.absolute, { kind: "restore", restoredFrom: n });
  return Response.json({ version }, { headers: { "Cache-Control": "no-store" } });
}
