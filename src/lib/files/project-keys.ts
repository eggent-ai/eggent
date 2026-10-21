import fs from "node:fs/promises";
import path from "node:path";
import { projectsDirectory } from "@/lib/files/versions/capture";
import { getWorkDir } from "@/lib/storage/project-store";

/**
 * A file of this workspace named the way the company's services name it: by
 * its path under the projects folder - the same key its history goes by - so
 * one file is one approval, one share, whichever project's screen it was
 * reached from.
 */

let realRoot: { of: string; real: string } | null = null;

/** The projects folder with every link on its way resolved, which a real path is compared with. */
export async function projectsRootReal(): Promise<string> {
  const configured = projectsDirectory();
  if (realRoot?.of === configured) return realRoot.real;
  realRoot = { of: configured, real: await fs.realpath(configured).catch(() => configured) };
  return realRoot.real;
}

/** The absolute path a scope and a path in it name, or null when it leaves the scope's folder. */
export function absoluteInScope(projectId: string, filePath: string): string | null {
  let workDir: string;
  try {
    workDir = path.resolve(getWorkDir(projectId));
  } catch {
    return null;
  }
  const absolute = path.resolve(workDir, filePath);
  return absolute.startsWith(workDir + path.sep) ? absolute : null;
}

const BAD_SEGMENT = (segment: string) => !segment || segment === "." || segment === "..";

/** The path of a file under the projects folder, with forward slashes; null for anything outside it. */
export async function keyOfFile(absolute: string): Promise<string | null> {
  const root = await projectsRootReal();
  const parent = await fs.realpath(path.dirname(path.resolve(absolute))).catch(() => null);
  if (!parent || (parent !== root && !parent.startsWith(root + path.sep))) return null;
  const key = path.relative(root, path.join(parent, path.basename(absolute))).split(path.sep).join("/");
  if (!key || key.startsWith("..") || key.split("/").some(BAD_SEGMENT)) return null;
  return key;
}

/** Where a key is on disk; null for a key that is not a plain path under the projects folder. */
export async function absoluteOfKey(key: string): Promise<string | null> {
  const segments = String(key || "").split("/");
  if (!key || segments.some(BAD_SEGMENT) || segments.some((segment) => segment.includes("\\"))) return null;
  return path.join(await projectsRootReal(), ...segments);
}
