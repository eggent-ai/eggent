import type { NextRequest } from "next/server";
import path from "node:path";
import { Readable } from "node:stream";
import { getServerTranslator } from "@/i18n/server";
import { contentDisposition } from "@/lib/files/download-headers";
import { formatUploadSize } from "@/lib/files/upload-limits";
import { planZip, ZipLimitError, ZipPathError, type ZipPlan } from "@/lib/files/zip-walk";
import { zipStream } from "@/lib/files/zip-writer";
import { projectFolderIsLink, workDirOrNull } from "@/lib/files/workspace-root";

/**
 * A folder, or a set of files, as one .zip.
 *
 *   GET /api/files/zip?project=<id|none>&path=<folder>          one folder
 *   GET /api/files/zip?project=<id|none>&path=a&path=b          these files
 *   ...&check=1                                                  what it would hold, as JSON
 *
 * The archive is written as it is read, so a large folder costs the container a
 * few buffers rather than its memory, and one archive is made at a time: the
 * process also runs the agent. Links are not followed, files that hold
 * credentials are left out (the answer to `check` says how many), and an
 * archive that would be unreasonable is refused with the reason before any of
 * it is sent.
 *
 * The single place is held only while somebody is taking the archive. A reader
 * that stops reading - a connection that went quiet, a request that asked for
 * the headers and never took the body - would otherwise keep every other
 * download out for ever, so an archive that has not moved for a while is let go.
 */

const ACTIVE_KEY = "__EGGENT_ZIP_ACTIVE__";

function active(): { count: number } {
  const holder = globalThis as typeof globalThis & { [ACTIVE_KEY]?: { count: number } };
  if (!holder[ACTIVE_KEY]) holder[ACTIVE_KEY] = { count: 0 };
  return holder[ACTIVE_KEY];
}

/** How long an archive may stand still before it is dropped. */
function idleLimitMs(): number {
  const seconds = Number.parseInt(process.env.EGGENT_ZIP_IDLE_SECONDS ?? "", 10);
  return (Number.isFinite(seconds) && seconds >= 1 ? seconds : 120) * 1000;
}

type Prepared =
  | { ok: false; response: Response }
  | { ok: true; plan: ZipPlan; fileName: string };

async function prepare(req: NextRequest): Promise<Prepared> {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const refuse = (body: Record<string, unknown>, status: number, headers?: Record<string, string>): Prepared => ({
    ok: false,
    response: Response.json(body, { status, headers }),
  });

  const projectId = req.nextUrl.searchParams.get("project");
  if (!projectId) return refuse({ error: t("api.error.projectIdRequired") }, 400);
  const requested = req.nextUrl.searchParams.getAll("path");
  const targets = requested.length > 0 ? requested : [""];

  // A project id is a name, and a name that is not one is refused rather than failing in the middle.
  const folder = workDirOrNull(projectId);
  if (!folder || (await projectFolderIsLink(projectId))) return refuse({ error: t("api.error.invalidFilePath") }, 403);
  const workDir = path.resolve(folder);

  let plan: ZipPlan;
  try {
    // One folder unpacks as that folder; several files keep their place in the workspace.
    const single = targets.length === 1 ? targets[0] : null;
    const base = single && single.trim() ? path.dirname(path.resolve(workDir, single)) : undefined;
    plan = await planZip(workDir, targets, { base });
  } catch (error) {
    if (error instanceof ZipPathError) return refuse({ error: t("api.error.invalidFilePath") }, 403);
    if (error instanceof ZipLimitError) {
      if (error.kind === "empty") return refuse({ error: t("api.error.zipEmpty"), reason: "empty" }, 404);
      if (error.kind === "depth") return refuse({ error: t("api.error.zipTooDeep"), reason: "depth" }, 413);
      if (error.kind === "files") {
        return refuse({ error: t("api.error.zipTooMany", { count: error.actual, limit: error.limit }), reason: "files", limit: error.limit }, 413);
      }
      return refuse(
        {
          error: t("api.error.zipTooLarge", { size: formatUploadSize(error.actual), limit: formatUploadSize(error.limit) }),
          reason: "bytes",
          limit: error.limit,
        },
        413
      );
    }
    return refuse({ error: t("api.error.fileNotFound") }, 404);
  }

  const single = targets.length === 1 ? targets[0] : "";
  const folderName = single.trim()
    ? path.basename(single)
    : projectId === "none" ? "workspace" : path.basename(workDir) || "project";
  return { ok: true, plan, fileName: targets.length > 1 ? "files.zip" : `${folderName}.zip` };
}

function archiveHeaders(fileName: string): Record<string, string> {
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": contentDisposition("attachment", fileName),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

/** What a download would be, without making one: the headers, and no place held. */
export async function HEAD(req: NextRequest) {
  const prepared = await prepare(req);
  if (!prepared.ok) return new Response(null, { status: prepared.response.status });
  return new Response(null, { headers: archiveHeaders(prepared.fileName) });
}

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const prepared = await prepare(req);
  if (!prepared.ok) return prepared.response;
  const { plan, fileName } = prepared;

  if (req.nextUrl.searchParams.get("check") === "1") {
    return Response.json({ files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped });
  }

  const state = active();
  if (state.count >= 1) {
    return Response.json({ error: t("api.error.zipBusy"), reason: "busy" }, { status: 429, headers: { "Retry-After": "10" } });
  }
  state.count += 1;

  const limit = idleLimitMs();
  let lastMoved = Date.now();
  const stream = zipStream(plan.files, {
    signal: req.signal,
    root: plan.root,
    onActivity: () => {
      lastMoved = Date.now();
    },
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(idle);
    state.count = Math.max(0, state.count - 1);
  };
  const idle = setInterval(() => {
    if (Date.now() - lastMoved <= limit) return;
    stream.destroy(new Error("The archive was dropped: nobody was taking it."));
    // The place is given back here, not left to the stream's own end: a stream stuck in a call
    // that cannot be interrupted never reaches it, and a place held by that is held for ever.
    release();
  }, Math.max(250, Math.min(10_000, Math.floor(limit / 4))));
  (idle as { unref?: () => void }).unref?.();
  stream.once("close", release);
  stream.once("error", release);
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { headers: archiveHeaders(fileName) });
}
