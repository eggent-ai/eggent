import fs from "node:fs/promises";
import path from "node:path";
import { isHiddenFileName } from "@/lib/storage/project-store";
import type { ZipFile } from "@/lib/files/zip-writer";

/**
 * Deciding what goes into an archive of somebody's folder.
 *
 * The folder belongs to an agent that has a shell: it can leave a link to
 * anywhere in it, put a key file beside the work, or fill the disk with a
 * thousand small files. So the walk follows no link, never leaves the folder it
 * was given, leaves out the files that hold credentials (and says how many),
 * and gives up with a named reason when the result would be unreasonable,
 * instead of discovering that halfway through a download.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const MAX_DEPTH = 20;

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** What one archive may hold: 1 GiB and 10 000 files unless the deployment says otherwise. */
export function zipLimits(env: Record<string, string | undefined> = process.env): { maxBytes: number; maxFiles: number } {
  return {
    maxBytes: Math.floor(positive(env.EGGENT_ZIP_MAX_MB, DEFAULT_MAX_BYTES / (1024 * 1024)) * 1024 * 1024),
    // The format's own ceiling is 65 534 entries, so a larger setting is clamped.
    maxFiles: Math.min(0xfffe, Math.floor(positive(env.EGGENT_ZIP_MAX_FILES, DEFAULT_MAX_FILES))),
  };
}

/** Folders nobody wants in a download: dependencies, caches and the runtime's own state. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "__pycache__", ".pi", ".cache", ".next"]);
/** Folders that exist to hold credentials: left out whole, and counted with the files that hold them. */
const CREDENTIAL_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".gcloud"]);
const SKIPPED_FILES = new Set([".ds_store", "thumbs.db"]);

/**
 * Files that hold credentials. They are left out of an archive, and the person is told so.
 *
 * Names, not contents: reading every file for something that looks like a key would
 * be slow and would still miss most. A file that is left out by mistake costs one
 * click in the Files panel, where it can be taken on its own.
 */
const SECRET_FILE = new RegExp(
  `^(?:${[
    "\\.env(?:\\..*)?", ".*\\.env", "\\.env~", "\\.envrc",
    "\\.mcp\\.json", "mcp\\.json", "auth\\.json", "tokens?\\.json",
    "\\.npmrc", "\\.netrc", "_netrc", "\\.pgpass", "\\.pypirc", "\\.htpasswd", "htpasswd",
    "\\.git-credentials", "\\.dockercfg", "\\.s3cfg", "\\.boto", "\\.vault[-_]?pass.*",
    "id_(?:rsa|dsa|ecdsa|ed25519).*",
    ".*\\.(?:pem|p12|pfx|key|keystore|jks|ppk|p8|kdbx|gpg)",
    "credentials(?:\\.(?:json|ya?ml|toml|ini|txt|csv|xml))?",
    "client_secrets?.*\\.json", ".*service[-_]?account.*\\.json", "firebase-adminsdk.*\\.json",
    "kubeconfig(?:\\..*)?",
    "secrets?\\.(?:json|ya?ml|toml|env|ini|txt)",
    ".*\\.tfstate(?:\\..*)?", ".*\\.tfvars(?:\\..*)?", "wp-config\\.php",
  ].join("|")})$`,
  "i"
);

export function isSecretFileName(name: string): boolean {
  return SECRET_FILE.test(name);
}

export type ZipLimitKind = "bytes" | "files" | "empty" | "depth";

export class ZipLimitError extends Error {
  readonly kind: ZipLimitKind;
  readonly limit: number;
  readonly actual: number;

  constructor(kind: ZipLimitKind, limit: number, actual: number) {
    super(`archive limit: ${kind}`);
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
  }
}

/** A path that is not inside the folder it was asked of. */
export class ZipPathError extends Error {
  constructor() {
    super("path outside the folder");
  }
}

export interface ZipPlan {
  files: ZipFile[];
  bytes: number;
  /** The real path of the folder the files are in; the writer checks each file against it when it opens it. */
  root: string;
  /** What was left out, by reason. */
  skipped: { secrets: number; links: number; hidden: number; unreadable: number };
}

export interface ZipLimits {
  maxBytes?: number;
  maxFiles?: number;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function archiveName(base: string, absolute: string): string {
  const relative = path.relative(base, absolute);
  // A backslash is a path separator to the tools that unpack on Windows: a file called
  // `..\\..\\x` would leave the folder it is unpacked into. It stays a file, with another name.
  return relative.split(path.sep).join("/").replace(/\\/g, "_");
}

/**
 * What an archive of `targets` (paths inside `workDir`, "" for the whole folder)
 * would hold. Names inside the archive are relative to `base`, which defaults to
 * the folder itself; a single folder is archived relative to its parent so it
 * unpacks as one folder rather than as a heap.
 */
export async function planZip(
  workDir: string,
  targets: readonly string[],
  options: ZipLimits & { base?: string } = {}
): Promise<ZipPlan> {
  const limits = zipLimits();
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const maxFiles = options.maxFiles ?? limits.maxFiles;
  const rootReal = await fs.realpath(path.resolve(workDir));
  const base = options.base ? path.resolve(rootReal, options.base) : rootReal;
  const plan: ZipPlan = { files: [], bytes: 0, root: rootReal, skipped: { secrets: 0, links: 0, hidden: 0, unreadable: 0 } };
  const seen = new Set<string>();

  const add = async (absolute: string): Promise<void> => {
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      // Gone since it was listed, or a name the system cannot give back (bytes that are not text).
      plan.skipped.unreadable += 1;
      return;
    }
    if (!stat.isFile()) return;
    // A file with a second name somewhere else may be a door to a file that is not in this folder.
    if (stat.nlink > 1) {
      plan.skipped.links += 1;
      return;
    }
    const name = archiveName(base, absolute);
    if (!name || name === ".." || name.startsWith("../") || seen.has(name)) return;
    seen.add(name);
    plan.bytes += stat.size;
    if (plan.bytes > maxBytes) throw new ZipLimitError("bytes", maxBytes, plan.bytes);
    if (plan.files.length + 1 > maxFiles) throw new ZipLimitError("files", maxFiles, plan.files.length + 1);
    plan.files.push({ name, filePath: absolute, size: stat.size, mode: stat.mode, mtime: stat.mtime });
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new ZipLimitError("depth", MAX_DEPTH, depth);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      // A folder that cannot be opened is left out and counted, not the end of the archive.
      plan.skipped.unreadable += 1;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        plan.skipped.links += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (CREDENTIAL_DIRECTORIES.has(entry.name)) {
          plan.skipped.secrets += 1;
          continue;
        }
        if (isHiddenFileName(entry.name) || SKIPPED_DIRECTORIES.has(entry.name)) {
          plan.skipped.hidden += 1;
          continue;
        }
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHiddenFileName(entry.name) || SKIPPED_FILES.has(entry.name.toLowerCase())) {
        plan.skipped.hidden += 1;
        continue;
      }
      if (isSecretFileName(entry.name)) {
        plan.skipped.secrets += 1;
        continue;
      }
      await add(absolute);
    }
  };

  for (const target of targets) {
    const absolute = path.resolve(rootReal, target);
    // The lexical check first, so a path that merely names somewhere else never touches the disk...
    if (!inside(rootReal, absolute)) throw new ZipPathError();
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      plan.skipped.links += 1;
      continue;
    }
    // ...and then the real one, since a folder on the way can itself be a link out.
    const real = await fs.realpath(absolute);
    if (!inside(rootReal, real)) throw new ZipPathError();
    // Naming a folder is not a way round what a walk leaves out.
    const name = path.basename(absolute);
    if (stat.isDirectory()) {
      if (absolute !== rootReal && CREDENTIAL_DIRECTORIES.has(name)) {
        plan.skipped.secrets += 1;
      } else if (absolute !== rootReal && (isHiddenFileName(name) || SKIPPED_DIRECTORIES.has(name))) {
        plan.skipped.hidden += 1;
      } else {
        await walk(absolute, 0);
      }
    } else if (stat.isFile()) {
      if (isSecretFileName(name)) {
        plan.skipped.secrets += 1;
      } else if (isHiddenFileName(name) || SKIPPED_FILES.has(name.toLowerCase())) {
        plan.skipped.hidden += 1;
      } else {
        await add(absolute);
      }
    }
  }

  if (plan.files.length === 0) throw new ZipLimitError("empty", 0, 0);
  return plan;
}
