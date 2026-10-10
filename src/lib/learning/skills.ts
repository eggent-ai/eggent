import fs from "fs/promises";
import path from "path";
import { learningLimits } from "@/lib/learning/config";
import { cleanDocument, scanForMemory } from "@/lib/learning/guard";
import { appendJournal, type JournalEntry } from "@/lib/learning/journal";
import { orchestratorSkillsDir } from "@/lib/learning/paths";

/**
 * Skills the agent writes for itself.
 *
 * A skill is a procedure for a kind of task, in the same SKILL.md format as any
 * other, kept in the orchestrator's `skills/` next to the ones the person
 * installed - which is also what puts it on the person's other computers. What
 * marks one as the agent's own is a line in its front matter, `origin: learned`.
 * The agent may change only those: a skill the person wrote or installed is
 * theirs, and a changed copy of an installed one would stop receiving the
 * improvements it came with.
 *
 * Nothing here deletes. A skill that stops being useful is moved aside by the
 * housekeeping pass, where it can still be found.
 */

export const LEARNED_ORIGIN = "learned";
const SKILL_FILE = "SKILL.md";
const SUPPORT_DIRS = new Set(["references", "templates", "scripts", "assets"]);
const SUPPORT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".tsv", ".py", ".sh", ".js", ".mjs", ".ts", ".html", ".css", ".sql", ".xml",
]);

export type SkillResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// --- Front matter ----------------------------------------------------------

export function parseSkillFile(raw: string): { frontmatter: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text.trim() };
  const block = text.slice(4, end);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1].toLowerCase()] = value;
  }
  return { frontmatter, body: text.slice(end + 4).replace(/^\n+/, "").trim() };
}

function renderSkillFile(meta: { name: string; description: string; learnedAt: string }, body: string): string {
  return [
    "---",
    `name: ${meta.name}`,
    `description: "${meta.description}"`,
    `origin: ${LEARNED_ORIGIN}`,
    `learned_at: "${meta.learnedAt}"`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

// --- Names and paths -------------------------------------------------------

/** Null when the name is acceptable for a skill the agent makes. */
export function checkLearnedSkillName(name: string): string | null {
  const limits = learningLimits();
  if (!name) return "a name is required";
  if (name.length > limits.skillNameChars) return `the name is longer than ${limits.skillNameChars} characters`;
  if (name.length < 3) return "the name is too short to mean anything";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return "use lowercase letters, digits and single hyphens only, for example weekly-report-from-spreadsheet";
  }
  // A skill is for a kind of task. A number between hyphens is nearly always a
  // ticket, a date or one occasion - which is a diary entry, not a skill.
  if (name.split("-").some((part) => /^\d+$/.test(part))) {
    return "name the kind of task, not an occasion: no ticket numbers, dates or counters between hyphens";
  }
  return null;
}

/** Any skill's name as the runtime spells it. Enough to be sure it is not a path. */
function isSafeSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function skillDir(name: string): string {
  return path.join(orchestratorSkillsDir(), name);
}

async function isRealDirectory(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where a support file goes, or why it cannot. */
export function resolveSupportFile(name: string, relative: string): SkillResult<{ absolute: string; relative: string }> {
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    return { ok: false, error: "the path must stay inside the skill" };
  }
  const parts = normalized.split("/");
  if (parts.length < 2 || !SUPPORT_DIRS.has(parts[0])) {
    return { ok: false, error: `put the file under one of: ${[...SUPPORT_DIRS].join(", ")} (for example references/notes.md)` };
  }
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
    return { ok: false, error: "file and folder names may use letters, digits, dots, hyphens and underscores only" };
  }
  if (!SUPPORT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    return { ok: false, error: `only text files can be saved (${[...SUPPORT_EXTENSIONS].join(" ")})` };
  }
  const root = skillDir(name);
  const absolute = path.join(root, ...parts);
  if (!absolute.startsWith(root + path.sep)) return { ok: false, error: "the path must stay inside the skill" };
  return { ok: true, absolute, relative: normalized };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf-8");
  await fs.rename(temp, file);
}

interface LockHolder {
  __eggentLearnedSkillsLock?: Promise<unknown>;
}

function withLock<T>(work: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as LockHolder;
  const previous = holder.__eggentLearnedSkillsLock ?? Promise.resolve();
  const next = previous.then(work, work);
  holder.__eggentLearnedSkillsLock = next.catch(() => undefined);
  return next;
}

// --- Reading ---------------------------------------------------------------

export interface SkillSummary {
  name: string;
  description: string;
  learned: boolean;
  learnedAt?: string;
  dir: string;
}

/** Every skill in the orchestrator's directory, the agent's own marked. */
export async function listOrchestratorSkills(): Promise<SkillSummary[]> {
  const root = orchestratorSkillsDir();
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const raw = await fs.readFile(path.join(root, entry.name, SKILL_FILE), "utf-8");
      const { frontmatter } = parseSkillFile(raw);
      const description = (frontmatter.description ?? "").trim();
      skills.push({
        name: entry.name,
        description,
        learned: frontmatter.origin === LEARNED_ORIGIN,
        learnedAt: frontmatter.learned_at || undefined,
        dir: path.join(root, entry.name),
      });
    } catch {
      // A directory with no SKILL.md is not a skill.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillView {
  name: string;
  learned: boolean;
  content: string;
  files: string[];
}

export async function viewSkill(name: string, file?: string): Promise<SkillResult<SkillView & { file: string }>> {
  if (!isSafeSkillName(name)) return { ok: false, error: `no skill named "${name}"` };
  const dir = skillDir(name);
  if (!(await isRealDirectory(dir))) return { ok: false, error: `no skill named "${name}"` };
  let target = path.join(dir, SKILL_FILE);
  let shown = SKILL_FILE;
  if (file && file !== SKILL_FILE) {
    const resolved = resolveSupportFile(name, file);
    if (!resolved.ok) return resolved;
    target = resolved.absolute;
    shown = resolved.relative;
  }
  let content: string;
  try {
    content = await fs.readFile(target, "utf-8");
  } catch {
    return { ok: false, error: `no file ${shown} in skill "${name}"` };
  }
  const { frontmatter } = parseSkillFile(await fs.readFile(path.join(dir, SKILL_FILE), "utf-8").catch(() => ""));
  const files = await listSupportFiles(dir);
  return { ok: true, name, learned: frontmatter.origin === LEARNED_ORIGIN, content: content.slice(0, 30_000), files, file: shown };
}

async function listSupportFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of SUPPORT_DIRS) {
    try {
      for (const entry of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
        if (entry.isFile()) found.push(`${sub}/${entry.name}`);
      }
    } catch {
      // No such folder.
    }
  }
  return found.sort();
}

// --- Writing ---------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function journalSkill(action: string, name: string, detail: string, source: JournalEntry["source"], chatId?: string): JournalEntry {
  return { at: new Date().toISOString(), source, what: "skill", action, text: `${name}: ${detail}`.slice(0, 300), chatId };
}

function cleanDescription(raw: string): SkillResult<{ text: string }> {
  const limits = learningLimits();
  const text = raw.replace(/\s+/g, " ").replace(/["\\]/g, "'").trim();
  if (text.length < 15) return { ok: false, error: "the description should say what the skill does and when to use it (at least a sentence)" };
  if (text.length > limits.skillDescriptionChars) {
    return { ok: false, error: `the description is ${text.length} characters; keep it under ${limits.skillDescriptionChars}` };
  }
  const problem = scanForMemory(text, "note");
  if (problem) return { ok: false, error: `the description cannot be saved: ${problem}` };
  return { ok: true, text };
}

export function createLearnedSkill(
  params: { name: string; description: string; body: string },
  context: { source: JournalEntry["source"]; chatId?: string }
): Promise<SkillResult<{ name: string; dir: string }>> {
  return withLock(async () => {
    const limits = learningLimits();
    const name = params.name.trim();
    const nameProblem = checkLearnedSkillName(name);
    if (nameProblem) return { ok: false, error: `Skill name rejected: ${nameProblem}.` };
    const description = cleanDescription(params.description);
    if (!description.ok) return description;
    const body = cleanDocument(params.body, limits.skillBodyChars);
    if (!body.ok) return { ok: false, error: `The skill body cannot be saved: ${body.reason}.` };
    if (body.text.length < 80) {
      return { ok: false, error: "The skill body is too thin to help. Write the steps, the pitfalls and how to check the result." };
    }

    const dir = skillDir(name);
    try {
      await fs.lstat(dir);
      return { ok: false, error: `A skill named "${name}" already exists. Patch it if it is a learned one, or pick a more specific name.` };
    } catch {
      // Free.
    }
    await writeAtomic(path.join(dir, SKILL_FILE), renderSkillFile({ name, description: description.text, learnedAt: today() }, body.text));
    await appendJournal([journalSkill("created", name, description.text, context.source, context.chatId)]);
    return { ok: true, name, dir };
  });
}

async function readOwnedSkill(name: string): Promise<SkillResult<{ dir: string; raw: string }>> {
  const nameProblem = checkLearnedSkillName(name);
  if (nameProblem) return { ok: false, error: `no learned skill named "${name}"` };
  const dir = skillDir(name);
  if (!(await isRealDirectory(dir))) return { ok: false, error: `no skill named "${name}"` };
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, SKILL_FILE), "utf-8");
  } catch {
    return { ok: false, error: `no skill named "${name}"` };
  }
  if (parseSkillFile(raw).frontmatter.origin !== LEARNED_ORIGIN) {
    return {
      ok: false,
      error: `"${name}" was not written by the agent, so it is not yours to change. Create a learned skill of your own if the procedure needs to differ.`,
    };
  }
  return { ok: true, dir, raw };
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

export function patchLearnedSkill(
  params: { name: string; oldString: string; newString: string; file?: string },
  context: { source: JournalEntry["source"]; chatId?: string }
): Promise<SkillResult<{ name: string; file: string }>> {
  return withLock(async () => {
    const limits = learningLimits();
    const owned = await readOwnedSkill(params.name.trim());
    if (!owned.ok) return owned;
    if (!params.oldString) return { ok: false, error: "old_string is required: the exact text to replace." };
    if (params.oldString === params.newString) return { ok: false, error: "old_string and new_string are the same." };

    const relative = !params.file || params.file === SKILL_FILE ? SKILL_FILE : params.file;
    let target = path.join(owned.dir, SKILL_FILE);
    let shown = SKILL_FILE;
    if (relative !== SKILL_FILE) {
      const resolved = resolveSupportFile(params.name.trim(), relative);
      if (!resolved.ok) return resolved;
      target = resolved.absolute;
      shown = resolved.relative;
    }
    let current: string;
    try {
      current = (await fs.readFile(target, "utf-8")).replace(/\r\n?/g, "\n");
    } catch {
      return { ok: false, error: `no file ${shown} in skill "${params.name}"` };
    }
    const found = occurrences(current, params.oldString);
    if (found === 0) return { ok: false, error: `old_string was not found in ${shown}. View the file and copy the text exactly.` };
    if (found > 1) return { ok: false, error: `old_string appears ${found} times in ${shown}; include more surrounding text so it appears once.` };

    const next = current.replace(params.oldString, () => params.newString);
    if (shown === SKILL_FILE) {
      const before = parseSkillFile(current);
      const after = parseSkillFile(next);
      if (after.frontmatter.name !== before.frontmatter.name || after.frontmatter.origin !== LEARNED_ORIGIN) {
        return { ok: false, error: "A patch may not change the skill's name or origin. Change the body, or the description line only." };
      }
      if (after.frontmatter.description !== before.frontmatter.description) {
        const description = cleanDescription(after.frontmatter.description ?? "");
        if (!description.ok) return description;
      }
      const body = cleanDocument(after.body, limits.skillBodyChars);
      if (!body.ok) return { ok: false, error: `The patched skill cannot be saved: ${body.reason}.` };
    } else {
      const checked = cleanDocument(next, limits.skillFileChars);
      if (!checked.ok) return { ok: false, error: `The patched file cannot be saved: ${checked.reason}.` };
    }
    await writeAtomic(target, next.endsWith("\n") ? next : `${next}\n`);
    await appendJournal([journalSkill("patched", params.name.trim(), `${shown}: ${params.newString.slice(0, 120)}`, context.source, context.chatId)]);
    return { ok: true, name: params.name.trim(), file: shown };
  });
}

export function writeLearnedSkillFile(
  params: { name: string; file: string; content: string },
  context: { source: JournalEntry["source"]; chatId?: string }
): Promise<SkillResult<{ name: string; file: string }>> {
  return withLock(async () => {
    const limits = learningLimits();
    const name = params.name.trim();
    const owned = await readOwnedSkill(name);
    if (!owned.ok) return owned;
    const resolved = resolveSupportFile(name, params.file);
    if (!resolved.ok) return resolved;
    const checked = cleanDocument(params.content, limits.skillFileChars);
    if (!checked.ok) return { ok: false, error: `The file cannot be saved: ${checked.reason}.` };
    const existing = await listSupportFiles(owned.dir);
    if (!existing.includes(resolved.relative) && existing.length >= limits.skillFiles) {
      return { ok: false, error: `A skill holds at most ${limits.skillFiles} support files.` };
    }
    await writeAtomic(resolved.absolute, `${checked.text}\n`);
    await appendJournal([journalSkill("patched", name, `file ${resolved.relative}`, context.source, context.chatId)]);
    return { ok: true, name, file: resolved.relative };
  });
}

/** Whether a name belongs to a skill the agent wrote. */
export async function isLearnedSkill(name: string): Promise<boolean> {
  if (checkLearnedSkillName(name)) return false;
  try {
    const raw = await fs.readFile(path.join(skillDir(name), SKILL_FILE), "utf-8");
    return parseSkillFile(raw).frontmatter.origin === LEARNED_ORIGIN;
  } catch {
    return false;
  }
}
