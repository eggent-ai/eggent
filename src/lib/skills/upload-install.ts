/**
 * Puts a checked skill into a workspace, or leaves the workspace as it was.
 *
 * The skill is written in full to a hidden folder beside its destination and
 * only then renamed into place, so what the runtime can see is either no skill
 * of that name or all of it - never a folder with half its files, which is what
 * a copy that fails in the middle leaves behind. Whatever goes wrong, the hidden
 * folder is removed; one a crashed process left is swept up by the next upload.
 *
 * Replacing a skill moves the old one aside instead of deleting it. The person
 * asked for the new file, not for the loss of whatever they had added to the old
 * folder, and an upload cannot tell the two apart.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CheckedSkill } from "@/lib/skills/upload-check";
import { ensureProjectSkillsDir, findProjectSkillDir } from "@/lib/storage/project-store";

/** Where an upload is assembled. A dot first keeps the runtime from reading it as a skill. */
const STAGING_PREFIX = ".incoming-";
const STAGING_MAX_AGE_MS = 15 * 60 * 1000;

/** Where a skill goes when a new file takes its place. */
export const REPLACED_DIRNAME = ".replaced";

export type SkillInstall =
  | {
      ok: true;
      dir: string;
      replaced: boolean;
      /** Where the previous version went, relative to the workspace's skills folder. */
      keptAs: string | null;
    }
  | { ok: false; code: "exists" | "writeFailed" };

function isTaken(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

/** Staging folders older than any upload could take, left by a process that died. */
async function sweepStaleStaging(base: string): Promise<void> {
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STAGING_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(base, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeTree(root: string, skill: CheckedSkill): Promise<void> {
  await fs.mkdir(root);
  const resolvedRoot = path.resolve(root);
  // The checks already refused any name that leaves the folder; this is the
  // same refusal again at the one place where it would do damage.
  const inside = (relative: string): string => {
    const target = path.resolve(resolvedRoot, ...relative.split("/"));
    if (!target.startsWith(resolvedRoot + path.sep)) throw new Error(`"${relative}" leaves the skill's folder`);
    return target;
  };

  for (const directory of skill.directories) await fs.mkdir(inside(directory), { recursive: true });
  for (const file of skill.files) {
    const target = inside(file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // `wx` because nothing may already be there: the folder was created a moment
    // ago, so a file that exists is two entries with one name.
    await fs.writeFile(target, file.data, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  }
}

/** Move a skill out of the way into `.replaced/<name>-<yyyymmdd>`; the path it went to. */
async function moveAside(from: string, base: string, name: string): Promise<string> {
  const folder = path.join(base, REPLACED_DIRNAME);
  await fs.mkdir(folder, { recursive: true });
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let target = path.join(folder, `${name}-${day}`);
  for (let attempt = 1; await fs.lstat(target).then(() => true, () => false); attempt += 1) {
    target = path.join(folder, `${name}-${day}-${attempt}`);
  }
  await fs.rename(from, target);
  return target;
}

export async function installUploadedSkill(
  projectId: string,
  skill: CheckedSkill,
  options: { replace: boolean }
): Promise<SkillInstall> {
  const base = await ensureProjectSkillsDir(projectId);
  const existing = await findProjectSkillDir(projectId, skill.name);
  if (existing && !options.replace) return { ok: false, code: "exists" };

  await sweepStaleStaging(base);

  const staging = path.join(base, `${STAGING_PREFIX}${randomBytes(6).toString("hex")}`);
  const target = path.join(base, skill.name);
  let committed = false;
  try {
    await writeTree(staging, skill);

    let movedTo: string | null = null;
    if (existing) movedTo = await moveAside(existing, base, skill.name);
    try {
      await fs.rename(staging, target);
    } catch (error) {
      // The old skill goes back where it was; replacing must not end with none.
      if (existing && movedTo) await fs.rename(movedTo, existing).catch(() => undefined);
      throw error;
    }
    committed = true;
    return {
      ok: true,
      dir: target,
      replaced: Boolean(existing),
      keptAs: movedTo ? path.relative(base, movedTo).split(path.sep).join("/") : null,
    };
  } catch (error) {
    if (isTaken(error)) return { ok: false, code: "exists" };
    console.error(`Failed to install the uploaded skill "${skill.name}":`, error);
    return { ok: false, code: "writeFailed" };
  } finally {
    if (!committed) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
