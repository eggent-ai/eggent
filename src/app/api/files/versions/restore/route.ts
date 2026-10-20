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
 *   POST /api/files/versions/restore  { project, path, n, force? }  ->  { version, lost? }
 *
 * Nothing is lost by it. What the file holds now is kept first if the history
 * does not have it yet - a change made elsewhere a moment ago included - and the
 * restored text becomes a new version of its own ("restored from 5"), so going
 * back can itself be undone. When what the file holds now cannot be kept (it
 * has grown past the size a history is kept for, or cannot be read), the
 * restore is refused with `code: "unkept"` unless the person said `force`
 * after being told, and then answers `lost: true`: the screen must not say
 * that what was replaced is in the history.
 */

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; n?: unknown; force?: unknown } | null;
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

  const before = await captureBefore(target.absolute).catch(() => "unreadable" as const);
  if ((before === "too-large" || before === "unreadable") && body?.force !== true) {
    return Response.json({ error: t("files.history.restoreWouldLose"), code: "unkept" }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  try {
    await writeFileInside(target.absolute, content, await fs.realpath(getWorkDir(project)));
  } catch {
    return jsonError(t("files.history.restoreFailed"), 409);
  }
  const version = await captureAfter(target.absolute, { kind: "restore", restoredFrom: n });
  const lost = before === "too-large" || before === "unreadable";
  return Response.json({ version, ...(lost ? { lost: true } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
