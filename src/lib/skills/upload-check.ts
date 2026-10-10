/**
 * Decides whether an uploaded file is a skill, and which one.
 *
 * Everything here happens in memory. Nothing touches the disk until a skill has
 * passed every check, so a file that fails leaves no trace to clean up: the
 * work of "do not leave a half-installed skill behind" is mostly not starting
 * to install one.
 *
 * A skill arrives as a single `SKILL.md`, or as a ZIP archive (`.zip`, or
 * `.skill`, which is the same thing) that holds one. In an archive the skill
 * may sit at the top or inside one folder - the shape `zip -r skill.zip
 * my-skill` makes - and anything else is turned away with a pointer to where
 * `SKILL.md` was actually found, because "not found" alone sends a person
 * searching for a mistake that is usually one level of folders.
 *
 * The checks are about shape and safety, which is what can be decided about
 * somebody else's files: the header the runtime needs, names that cannot leave
 * the skill's folder, no links, a size that is a skill and not a payload. What
 * the scripts do is not something a file check can know.
 */
import { formatUploadSize } from "@/lib/files/upload-limits";
import { parseFrontmatterBlock, splitSkillFile } from "@/lib/skills/frontmatter";
import type { SkillIssue, SkillNoteCode } from "@/lib/skills/issues";
import {
  SKILL_ARCHIVE_MAX_BYTES,
  SKILL_COMPATIBILITY_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_MAX_FILES,
  SKILL_MD_MAX_BYTES,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  SKILL_UNPACKED_MAX_BYTES,
  skillUploadKind,
} from "@/lib/skills/limits";
import { ZipError, listZip, readZipEntry, type ZipEntry } from "@/lib/skills/zip-reader";

const SKILL_FILE = "SKILL.md";

export interface SkillFile {
  /** Relative to the skill's folder, with `/` separators. */
  path: string;
  data: Buffer;
  executable: boolean;
}

export interface CheckedSkill {
  name: string;
  description: string;
  /** Every file to write, `SKILL.md` among them, exactly as it will be written. */
  files: SkillFile[];
  /** Folders the archive lists, so an empty `assets/` is kept as it was sent. */
  directories: string[];
  notes: SkillNoteCode[];
}

export type SkillCheck = { ok: true; skill: CheckedSkill } | { ok: false; issues: SkillIssue[] };

function fail(...issues: SkillIssue[]): { ok: false; issues: SkillIssue[] } {
  return { ok: false, issues };
}

/** Long values are shortened before they go into a sentence. */
function shown(value: string, limit = 80): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// --- SKILL.md ---------------------------------------------------------------

interface SkillText {
  name: string;
  description: string;
  /** What is written: the file as it came, unless the agent's mark had to go. */
  contents: Buffer;
  notes: SkillNoteCode[];
}

const LEARNED_LINE = /^origin\s*:\s*(["']?)learned\1\s*(#.*)?$/;
const LEARNED_AT_LINE = /^learned_at\s*:/;

/**
 * The skill without the lines that say the agent wrote it, or null when they
 * cannot be taken out cleanly.
 *
 * `origin: learned` is how the agent recognises its own skills, and it changes
 * only those - and, left unused, archives them. A skill somebody uploads is
 * theirs, so the mark has to go or an exported skill would be treated as the
 * agent's in the workspace it was brought to.
 */
function withoutLearnedMark(text: string): string | null {
  const match = /^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!match) return null;
  const eol = match[2].includes("\r\n") ? "\r\n" : "\n";
  const kept = match[2].split(/\r?\n/).filter((line) => !LEARNED_LINE.test(line) && !LEARNED_AT_LINE.test(line));
  const next = match[1] + kept.join(eol) + text.slice(match[1].length + match[2].length);

  // Prove it worked rather than assume: a mark written some other way (inside
  // a `{ origin: learned }` line, say) is still there, and still counts.
  const split = splitSkillFile(next);
  if (!split.ok) return null;
  const header = parseFrontmatterBlock(split.block);
  if (!header.ok || (typeof header.data.origin === "string" && header.data.origin.trim() === "learned")) return null;
  return next;
}

function readSkillText(bytes: Buffer): { ok: true; text: SkillText } | { ok: false; issues: SkillIssue[] } {
  if (bytes.length > SKILL_MD_MAX_BYTES) {
    return fail({
      code: "skillMdTooLarge",
      params: { size: formatUploadSize(bytes.length), limit: formatUploadSize(SKILL_MD_MAX_BYTES) },
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail({ code: "skillMdNotText" });
  }
  if (text.includes("\u0000")) return fail({ code: "skillMdNotText" });

  const split = splitSkillFile(text);
  if (!split.ok) return fail({ code: split.reason === "missing" ? "frontmatterMissing" : "frontmatterUnclosed" });

  const header = parseFrontmatterBlock(split.block);
  if (!header.ok) {
    return fail(
      header.kind === "shape"
        ? { code: "frontmatterNotMap" }
        : { code: "frontmatterYaml", params: { line: header.line ?? 2, reason: shown(header.reason, 160) } }
    );
  }

  // Every field problem is reported, not only the first: a file missing both
  // name and description should not need two uploads to find that out.
  const issues: SkillIssue[] = [];
  const { name, description, compatibility } = header.data;

  const empty = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  if (empty(name)) {
    issues.push({ code: "fieldMissing", params: { field: "name" } });
  } else if (typeof name !== "string") {
    issues.push({ code: "fieldNotText", params: { field: "name" } });
  } else if (name.length > SKILL_NAME_MAX) {
    issues.push({ code: "fieldTooLong", params: { field: "name", length: name.length, limit: SKILL_NAME_MAX } });
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push({ code: "nameInvalid", params: { name: shown(name) } });
  }

  let descriptionText = "";
  if (empty(description)) {
    issues.push({ code: "fieldMissing", params: { field: "description" } });
  } else if (typeof description !== "string") {
    issues.push({ code: "fieldNotText", params: { field: "description" } });
  } else {
    descriptionText = description.trim();
    if (descriptionText.length > SKILL_DESCRIPTION_MAX) {
      issues.push({
        code: "fieldTooLong",
        params: { field: "description", length: descriptionText.length, limit: SKILL_DESCRIPTION_MAX },
      });
    }
  }

  if (typeof compatibility === "string" && compatibility.trim().length > SKILL_COMPATIBILITY_MAX) {
    issues.push({
      code: "fieldTooLong",
      params: { field: "compatibility", length: compatibility.trim().length, limit: SKILL_COMPATIBILITY_MAX },
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  const notes: SkillNoteCode[] = [];
  let contents = bytes;
  if (typeof header.data.origin === "string" && header.data.origin.trim() === "learned") {
    const cleaned = withoutLearnedMark(text);
    if (cleaned === null) return fail({ code: "learnedMarker" });
    contents = Buffer.from(cleaned, "utf-8");
    notes.push("learnedMarkerRemoved");
  }
  if (split.body === "") notes.push("emptyBody");

  return { ok: true, text: { name: name as string, description: descriptionText, contents, notes } };
}

// --- Archives ---------------------------------------------------------------

/**
 * A stored name as a path inside the skill, or null when it must not be
 * written: absolute, climbing out with `..`, carrying control characters, or
 * longer than a filesystem takes. `./` and doubled slashes are only noise.
 */
function cleanPath(raw: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || Buffer.byteLength(segment) > 255) return null;
    segments.push(segment);
  }
  const cleaned = segments.join("/");
  return Buffer.byteLength(cleaned) > 1024 ? null : cleaned;
}

const JUNK_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** What a file manager adds to an archive without anyone having asked. */
function isJunk(path: string): boolean {
  const segments = path.split("/");
  if (segments.includes("__MACOSX") || segments.includes(".git")) return true;
  const base = segments[segments.length - 1];
  return JUNK_FILE_NAMES.has(base) || base.startsWith("._");
}

function zipFailure(error: unknown): SkillIssue {
  if (!(error instanceof ZipError)) throw error;
  switch (error.code) {
    case "not-zip":
      return { code: "notZip" };
    case "encrypted":
      return { code: "zipEncrypted" };
    case "unsupported":
      return { code: "zipUnsupported", params: { detail: error.detail } };
    case "corrupt":
      // A damaged directory means the file is not a usable archive at all;
      // a damaged entry is one file the person can name.
      return error.detail === "central directory"
        ? { code: "notZip" }
        : { code: "zipCorrupt", params: { path: shown(error.detail, 120) } };
  }
}

interface Member {
  entry: ZipEntry;
  /** Path inside the archive, cleaned. */
  path: string;
}

/**
 * Where the skill is in the archive: its folder (empty for the top), or the
 * reason there is none to be found.
 */
function locateSkill(files: Member[]): { ok: true; root: string } | { ok: false; issue: SkillIssue } {
  const depth = (member: Member) => member.path.split("/").length - 1;
  const base = (member: Member) => member.path.slice(member.path.lastIndexOf("/") + 1);

  if (files.some((member) => member.path === SKILL_FILE)) return { ok: true, root: "" };

  const wrapped = files.filter((member) => base(member) === SKILL_FILE && depth(member) === 1);
  if (wrapped.length === 1) return { ok: true, root: wrapped[0].path.split("/")[0] };
  if (wrapped.length > 1) {
    const folders = wrapped.map((member) => member.path.split("/")[0]);
    const listed = folders.slice(0, 5).join(", ") + (folders.length > 5 ? ", …" : "");
    return { ok: false, issue: { code: "severalSkills", params: { names: listed } } };
  }

  // Not there. Say what is there instead, because the usual mistake is a file
  // named skill.md, or a skill one folder too deep.
  const lookalike = files.find((member) => base(member).toLowerCase() === SKILL_FILE.toLowerCase());
  if (lookalike) {
    return depth(lookalike) <= 1
      ? { ok: false, issue: { code: "skillMdCase", params: { path: shown(lookalike.path, 120) } } }
      : { ok: false, issue: { code: "skillMdNested", params: { path: shown(lookalike.path, 120) } } };
  }
  return { ok: false, issue: { code: "skillMdMissing" } };
}

async function checkArchive(data: Buffer): Promise<SkillCheck> {
  try {
    const entries = listZip(data);

    // Names are judged before anything else, junk included: an archive with an
    // entry that climbs out of its folder is not one to install from, whatever
    // else is in it.
    const members: Member[] = [];
    for (const entry of entries) {
      const path = cleanPath(entry.path);
      if (path === null) return fail({ code: "unsafePath", params: { path: shown(entry.path.replace(/[\u0000-\u001f\u007f]/g, "?"), 120) } });
      if (path !== "" && !isJunk(path)) members.push({ entry, path });
    }

    const located = locateSkill(members.filter((member) => member.entry.kind === "file"));
    if (!located.ok) return fail(located.issue);

    // Only what is inside the skill's folder is installed; whatever sits beside
    // it in the archive is not read, and so cannot be a problem.
    const prefix = located.root ? `${located.root}/` : "";
    const inside = members
      .filter((member) => member.path.startsWith(prefix) && member.path.length > prefix.length)
      .map((member) => ({ ...member, path: member.path.slice(prefix.length) }));

    for (const member of inside) {
      if (member.entry.kind === "link") return fail({ code: "link", params: { path: shown(member.path, 120) } });
      if (member.entry.encrypted) return fail({ code: "zipEncrypted" });
    }

    const files = inside.filter((member) => member.entry.kind === "file");
    const directories = inside.filter((member) => member.entry.kind === "directory").map((member) => member.path);

    // One name, one thing: the same path twice is ambiguous, and a path that is
    // a file here and a folder there cannot be written at all.
    const filePaths = new Set<string>();
    const folderPaths = new Set<string>(directories);
    for (const member of files) {
      if (filePaths.has(member.path)) return fail({ code: "duplicatePath", params: { path: shown(member.path, 120) } });
      filePaths.add(member.path);
      const parts = member.path.split("/");
      for (let i = 1; i < parts.length; i += 1) folderPaths.add(parts.slice(0, i).join("/"));
    }
    for (const folder of folderPaths) {
      if (filePaths.has(folder)) return fail({ code: "duplicatePath", params: { path: shown(folder, 120) } });
    }

    if (files.length + directories.length > SKILL_MAX_FILES) {
      return fail({ code: "tooManyFiles", params: { count: files.length + directories.length, limit: SKILL_MAX_FILES } });
    }
    const unpacked = files.reduce((sum, member) => sum + member.entry.size, 0);
    if (unpacked > SKILL_UNPACKED_MAX_BYTES) {
      return fail({
        code: "unpackedTooLarge",
        params: { size: formatUploadSize(unpacked), limit: formatUploadSize(SKILL_UNPACKED_MAX_BYTES) },
      });
    }

    // The instructions first: if the header is wrong there is no reason to
    // unpack anything else.
    const skillMd = files.find((member) => member.path === SKILL_FILE);
    if (!skillMd) return fail({ code: "skillMdMissing" });
    if (skillMd.entry.size > SKILL_MD_MAX_BYTES) {
      return fail({
        code: "skillMdTooLarge",
        params: { size: formatUploadSize(skillMd.entry.size), limit: formatUploadSize(SKILL_MD_MAX_BYTES) },
      });
    }
    const read = readSkillText(await readZipEntry(data, skillMd.entry));
    if (!read.ok) return read;

    const written: SkillFile[] = [{ path: SKILL_FILE, data: read.text.contents, executable: false }];
    for (const member of files) {
      if (member === skillMd) continue;
      written.push({ path: member.path, data: await readZipEntry(data, member.entry), executable: member.entry.executable });
    }

    return {
      ok: true,
      skill: {
        name: read.text.name,
        description: read.text.description,
        files: written,
        directories,
        notes: read.text.notes,
      },
    };
  } catch (error) {
    return fail(zipFailure(error));
  }
}

// --- The upload -------------------------------------------------------------

export async function checkSkillUpload(input: { fileName: string; data: Buffer }): Promise<SkillCheck> {
  const kind = skillUploadKind(input.fileName);
  if (!kind) return fail({ code: "unsupportedType", params: { name: shown(input.fileName, 120) } });
  if (input.data.length === 0) return fail({ code: "empty" });
  if (input.data.length > SKILL_ARCHIVE_MAX_BYTES) {
    return fail({
      code: "tooLarge",
      params: { size: formatUploadSize(input.data.length), limit: formatUploadSize(SKILL_ARCHIVE_MAX_BYTES) },
    });
  }

  if (kind === "archive") return checkArchive(input.data);

  const read = readSkillText(input.data);
  if (!read.ok) return read;
  return {
    ok: true,
    skill: {
      name: read.text.name,
      description: read.text.description,
      files: [{ path: SKILL_FILE, data: read.text.contents, executable: false }],
      directories: [],
      notes: read.text.notes,
    },
  };
}
