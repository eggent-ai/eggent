import path from "node:path";

/**
 * What an upload does when the name it wants is already taken.
 *
 * `skip` is what the route has always done: an existing file is left alone and
 * the upload is reported as an error for that one name. The other two exist
 * because refusing was the only answer available, which made replacing a file
 * from the dashboard impossible.
 */
export type UploadConflictPolicy = "skip" | "overwrite" | "rename";

/**
 * Largest request the upload route accepts, in megabytes, unless the install
 * says otherwise through `EGGENT_MAX_UPLOAD_MB`.
 *
 * A multipart body is parsed into memory before any of it reaches the disk, so
 * an unbounded route is an unbounded allocation: one dropped video is enough to
 * take the process down. The number is a compromise - large enough for the
 * documents and datasets this dashboard is for, small enough to survive.
 */
export const DEFAULT_MAX_UPLOAD_MB = 100;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Read the configured request limit.
 *
 * An explicit `0` removes the limit, for installs that know their memory and
 * their reverse proxy. Anything unparseable falls back to the default rather
 * than to no limit at all: a typo in an env file should not quietly disable a
 * safety net.
 */
export function resolveMaxUploadBytes(value?: string | null): number {
  const raw = (value ?? "").trim();
  if (!raw) return DEFAULT_MAX_UPLOAD_MB * BYTES_PER_MB;

  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes < 0) return DEFAULT_MAX_UPLOAD_MB * BYTES_PER_MB;
  if (megabytes === 0) return Number.POSITIVE_INFINITY;

  return megabytes * BYTES_PER_MB;
}

/**
 * The declared body size, when the client declared one that makes sense.
 *
 * This is what lets an oversized upload be refused before it is read, which is
 * the only refusal that actually saves the memory.
 */
export function parseContentLength(value?: string | null): number | null {
  if (!value) return null;

  const size = Number(value.trim());
  if (!Number.isFinite(size) || size < 0) return null;

  return size;
}

export function resolveConflictPolicy(value?: string | null): UploadConflictPolicy {
  const policy = (value ?? "").trim().toLowerCase();
  if (policy === "overwrite" || policy === "rename") return policy;
  return "skip";
}

/**
 * A relative path an upload may use, or null when it may not use one.
 *
 * Browsers hand over paths from three different places - a picked file, a
 * dropped directory entry, a `webkitRelativePath` - and each of them can carry
 * a separator, a traversal, or a stray space. Everything that could address a
 * file outside the target directory is rejected here rather than repaired,
 * because a repaired path is a guess about what the user meant.
 */
export function safeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.replace(/[\0]/g, "").trim())
    .filter(Boolean);

  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  if (path.posix.isAbsolute(normalized)) return null;

  return segments.join("/");
}

/**
 * Resolve a relative path inside a directory, refusing anything that lands
 * outside it even after the filesystem has had its say about the name.
 */
export function resolveSafeChildPath(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedChild = path.resolve(rootDir, ...relativePath.split("/"));
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid child path");
  }
  return resolvedChild;
}

/**
 * The name a renaming upload tries next: `notes.md` becomes `notes (1).md`.
 *
 * The extension is kept so the copy opens in whatever the original opened in.
 * A leading dot is part of the name and not an extension, so `.env` becomes
 * `.env (1)` rather than ` (1).env`.
 */
export function buildRenameCandidate(filePath: string, attempt: number): string {
  const separator = filePath.lastIndexOf("/");
  const directory = separator === -1 ? "" : filePath.slice(0, separator + 1);
  const name = separator === -1 ? filePath : filePath.slice(separator + 1);

  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";

  return `${directory}${base} (${attempt})${extension}`;
}

/**
 * How many renamed candidates are tried before an upload gives up.
 *
 * The loop has to end somewhere, and a directory holding a thousand copies of
 * the same name is a mistake worth reporting rather than a case worth serving.
 */
const MAX_RENAME_ATTEMPTS = 999;

/**
 * Where a file should be written, given the policy and what is already there.
 *
 * Returns null when the upload should not happen at all: the name is taken and
 * the policy is to leave it alone, or renaming ran out of candidates. The
 * existence check is passed in so this decision can be made - and tested -
 * without a filesystem.
 */
export async function resolveUploadTarget(
  relativePath: string,
  policy: UploadConflictPolicy,
  exists: (candidate: string) => Promise<boolean>
): Promise<{ relativePath: string; overwrite: boolean } | null> {
  if (policy === "overwrite") {
    return { relativePath, overwrite: await exists(relativePath) };
  }

  if (!(await exists(relativePath))) {
    return { relativePath, overwrite: false };
  }

  if (policy === "skip") return null;

  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    const candidate = buildRenameCandidate(relativePath, attempt);
    if (!(await exists(candidate))) {
      return { relativePath: candidate, overwrite: false };
    }
  }

  return null;
}
