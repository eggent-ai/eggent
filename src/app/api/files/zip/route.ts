import type { NextRequest } from "next/server";
import path from "node:path";
import { Readable } from "node:stream";
import { getWorkDir } from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";
import { contentDisposition } from "@/lib/files/download-headers";
import { formatUploadSize } from "@/lib/files/upload-limits";
import { planZip, ZipLimitError, ZipPathError } from "@/lib/files/zip-walk";
import { zipStream } from "@/lib/files/zip-writer";

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
 */

const ACTIVE_KEY = "__EGGENT_ZIP_ACTIVE__";

function active(): { count: number } {
  const holder = globalThis as typeof globalThis & { [ACTIVE_KEY]?: { count: number } };
  if (!holder[ACTIVE_KEY]) holder[ACTIVE_KEY] = { count: 0 };
  return holder[ACTIVE_KEY];
}

export async function GET(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const projectId = req.nextUrl.searchParams.get("project");
  if (!projectId) {
    return Response.json({ error: t("api.error.projectIdRequired") }, { status: 400 });
  }
  const requested = req.nextUrl.searchParams.getAll("path");
  const targets = requested.length > 0 ? requested : [""];
  const workDir = path.resolve(getWorkDir(projectId));

  let plan;
  try {
    // One folder unpacks as that folder; several files keep their place in the workspace.
    const single = targets.length === 1 ? targets[0] : null;
    const base = single && single.trim() ? path.dirname(path.resolve(workDir, single)) : undefined;
    plan = await planZip(workDir, targets, { base });
  } catch (error) {
    if (error instanceof ZipPathError) {
      return Response.json({ error: t("api.error.invalidFilePath") }, { status: 403 });
    }
    if (error instanceof ZipLimitError) {
      if (error.kind === "empty") return Response.json({ error: t("api.error.zipEmpty"), reason: "empty" }, { status: 404 });
      if (error.kind === "depth") return Response.json({ error: t("api.error.zipTooDeep"), reason: "depth" }, { status: 413 });
      if (error.kind === "files") {
        return Response.json(
          { error: t("api.error.zipTooMany", { count: error.actual, limit: error.limit }), reason: "files", limit: error.limit },
          { status: 413 }
        );
      }
      return Response.json(
        {
          error: t("api.error.zipTooLarge", { size: formatUploadSize(error.actual), limit: formatUploadSize(error.limit) }),
          reason: "bytes",
          limit: error.limit,
        },
        { status: 413 }
      );
    }
    return Response.json({ error: t("api.error.fileNotFound") }, { status: 404 });
  }

  if (req.nextUrl.searchParams.get("check") === "1") {
    return Response.json({ files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped });
  }

  const state = active();
  if (state.count >= 1) {
    return Response.json({ error: t("api.error.zipBusy"), reason: "busy" }, { status: 429, headers: { "Retry-After": "10" } });
  }
  state.count += 1;

  const stream = zipStream(plan.files, { signal: req.signal });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.count = Math.max(0, state.count - 1);
  };
  stream.once("close", release);
  stream.once("error", release);
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });

  const single = targets.length === 1 ? targets[0] : "";
  const folderName = single.trim()
    ? path.basename(single)
    : projectId === "none" ? "workspace" : path.basename(workDir) || "project";
  const fileName = targets.length > 1 ? "files.zip" : `${folderName}.zip`;

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", fileName),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
