/**
 * Starting the download of a folder, or a set of files, as one .zip.
 *
 * The archive is asked about first: an archive that is refused answers with a
 * reason, and a plain link to it would save that answer as a file called
 * folder.zip. Once it is known to be possible the browser takes it from the
 * route itself, so a large folder goes straight to disk and never through this
 * page's memory.
 */

export interface ZipCheck {
  files: number;
  bytes: number;
  /** What was left out, by reason: files that hold credentials, links, dependencies and the like. */
  skipped: { secrets: number; links: number; hidden: number; unreadable?: number };
}

export function zipUrl(projectId: string, paths: readonly string[], extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ project: projectId, ...extra });
  for (const path of paths) query.append("path", path);
  return `/api/files/zip?${query.toString()}`;
}

export type ZipStart = { ok: true; check: ZipCheck } | { ok: false; error: string; reason?: string };

export async function startZipDownload(projectId: string, paths: readonly string[]): Promise<ZipStart> {
  let response: Response;
  try {
    response = await fetch(zipUrl(projectId, paths, { check: "1" }), { cache: "no-store" });
  } catch {
    return { ok: false, error: "The connection was lost." };
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; reason?: string } | null;
    return { ok: false, error: body?.error || `Could not prepare the archive (${response.status}).`, reason: body?.reason };
  }
  const check = (await response.json()) as ZipCheck;
  const link = document.createElement("a");
  link.href = zipUrl(projectId, paths);
  link.download = "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { ok: true, check };
}
