import fs from "fs/promises";
import path from "path";
import {
  createProject,
  getProject,
  getProjectSkillsDir,
  GLOBAL_PROJECT_ID,
  isOrchestratorScope,
  validateSkillName,
} from "@/lib/storage/project-store";

const SKILL_FILE_NAME = "SKILL.md";
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), "bundled-skills");

/**
 * Skills that belong to the workspace itself rather than to one line of work.
 *
 * `about-you` writes who the user is into the orchestrator's own context.md,
 * which every chat reads. Putting it in a project would hide the answers from
 * every chat outside that project, which is the opposite of what it is for.
 */
const ORCHESTRATOR_SCOPED_SKILLS = new Set(["about-you"]);

export function isOrchestratorScopedSkill(skillName: string): boolean {
  return ORCHESTRATOR_SCOPED_SKILLS.has(skillName.trim().toLowerCase());
}

/** Where a card falls back to when a skill carries no card copy of its own. */
const DEFAULT_CARD_ORDER = 100;

export interface BundledSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Short human-facing card title in the requested language. */
  title: string;
  /** Short human-facing card summary in the requested language. */
  summary: string;
  /** Card position; lower comes first. */
  order: number;
}

/**
 * Card copy for a skill, in the language this deployment runs in.
 *
 * A skill's own `name` and `description` are written for the model — long,
 * English, and full of trigger phrases — which is unreadable on a card. Skills
 * may therefore carry optional `title_<locale>` / `summary_<locale>` frontmatter
 * keys purely for the UI. They are inert for the model: skill metadata passed to
 * Pi reads only `name` and `description`.
 *
 * Resolution falls back locale → English → unsuffixed key → the model-facing
 * text, so a skill without card copy renders exactly as it does today.
 */
function resolveCardText(
  frontmatter: Record<string, string>,
  field: "title" | "summary",
  locale: string,
  fallback: string
): string {
  const candidates = [
    frontmatter[`${field}_${locale.toLowerCase()}`],
    frontmatter[`${field}_en`],
    frontmatter[field],
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return fallback;
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
} {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {} };
  }

  const rest = trimmed.slice(3);
  const endIdx = rest.indexOf("\n---");
  const frontmatterBlock = endIdx >= 0 ? rest.slice(0, endIdx) : "";
  const frontmatter: Record<string, string> = {};

  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1].toLowerCase()] = value;
  }

  return { frontmatter };
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readBundledSkillFromDir(
  dirPath: string,
  fallbackName: string,
  locale: string
): Promise<BundledSkill | null> {
  const skillFilePath = path.join(dirPath, SKILL_FILE_NAME);
  let skillContent = "";

  try {
    skillContent = await fs.readFile(skillFilePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter } = parseFrontmatter(skillContent);
  const name = (frontmatter.name ?? fallbackName).trim().toLowerCase();
  const description = (frontmatter.description ?? "").trim().slice(0, 1024);
  const validationError = validateSkillName(name);

  if (validationError) return null;
  if (!description) return null;
  if (name !== fallbackName.toLowerCase()) return null;

  const parsedOrder = Number.parseInt(frontmatter.card_order ?? "", 10);

  return {
    name,
    description,
    license: frontmatter.license?.trim() || undefined,
    compatibility: frontmatter.compatibility?.trim() || undefined,
    title: resolveCardText(frontmatter, "title", locale, name),
    summary: resolveCardText(frontmatter, "summary", locale, description),
    order: Number.isFinite(parsedOrder) ? parsedOrder : DEFAULT_CARD_ORDER,
  };
}

export async function listBundledSkills(locale = "en"): Promise<BundledSkill[]> {
  try {
    const entries = await fs.readdir(BUNDLED_SKILLS_DIR, {
      withFileTypes: true,
    });
    const result: BundledSkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = await readBundledSkillFromDir(
        path.join(BUNDLED_SKILLS_DIR, entry.name),
        entry.name,
        locale
      );
      if (skill) result.push(skill);
    }

    // Skills declare their own card order, so the onboarding one can lead the
    // row without renaming its directory.
    return result.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function installBundledSkill(
  projectId: string,
  skillName: string
): Promise<
  | { success: true; targetDir: string }
  | { success: false; error: string; code: number }
> {
  const normalizedName = skillName.trim().toLowerCase();
  const validationError = validateSkillName(normalizedName);
  if (validationError) {
    return { success: false, error: validationError, code: 400 };
  }

  // "none" installs into the orchestrator's own skills directory.
  if (!isOrchestratorScope(projectId)) {
    const project = await getProject(projectId);
    if (!project) {
      return { success: false, error: "Project not found", code: 404 };
    }
  }

  const sourceDir = path.join(BUNDLED_SKILLS_DIR, normalizedName);
  if (!(await dirExists(sourceDir))) {
    return { success: false, error: "Bundled skill not found", code: 404 };
  }

  const sourceSkillFilePath = path.join(sourceDir, SKILL_FILE_NAME);
  try {
    await fs.access(sourceSkillFilePath);
  } catch {
    return {
      success: false,
      error: "Bundled skill is invalid: missing SKILL.md",
      code: 500,
    };
  }

  const targetBaseDir = getProjectSkillsDir(projectId);
  const targetDir = path.join(targetBaseDir, normalizedName);

  if (await dirExists(targetDir)) {
    return {
      success: false,
      error: `Skill "${normalizedName}" is already installed in this workspace`,
      code: 409,
    };
  }

  await fs.mkdir(targetBaseDir, { recursive: true });

  try {
    await fs.cp(sourceDir, targetDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    return { success: true, targetDir };
  } catch {
    return {
      success: false,
      error: "Failed to install bundled skill",
      code: 500,
    };
  }
}

/**
 * Install a bundled skill into an existing workspace and hand back the message
 * that starts it.
 *
 * Launching used to create a throwaway project for every skill, because the
 * orchestrator had nowhere to keep one. It does now, so the caller chooses:
 * "none" installs into the orchestrator, where the skill is available in every
 * chat, and a project id installs it there, where it costs nothing until that
 * project is opened. A skill already present in the target is reused rather
 * than treated as an error - relaunching it is a normal thing to do.
 */
/** A project id derived from a skill name, free of collisions with existing ones. */
async function uniqueProjectId(baseId: string): Promise<string> {
  const normalized = baseId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  let candidate = normalized;
  for (let i = 2; await getProject(candidate); i += 1) {
    candidate = `${normalized}-${i}`;
  }
  return candidate;
}

/**
 * Start a bundled skill from a quick-start card.
 *
 * A card is an offer to begin a piece of work, so tapping one gives that work
 * its own project and installs the skill there - no question about where it
 * should live, because at that point the user has nothing to base the answer
 * on. Only the skills that describe the workspace itself stay in the
 * orchestrator; see ORCHESTRATOR_SCOPED_SKILLS.
 *
 * An explicit `projectId` still wins: that is the path used from a project's
 * own skills screen, where the target is already chosen.
 */
export async function launchBundledSkill(
  skillName: string,
  projectId?: string
): Promise<
  | { success: true; skill: BundledSkill; projectId: string | null; initialMessage: string }
  | { success: false; error: string; code: number }
> {
  const normalizedName = skillName.trim().toLowerCase();
  const validationError = validateSkillName(normalizedName);
  if (validationError) {
    return { success: false, error: validationError, code: 400 };
  }

  const skill = (await listBundledSkills()).find((item) => item.name === normalizedName);
  if (!skill) {
    return { success: false, error: "Bundled skill not found", code: 404 };
  }

  const requestedScope = projectId?.trim();
  let targetScope: string;

  if (requestedScope) {
    if (!isOrchestratorScope(requestedScope) && !(await getProject(requestedScope))) {
      return { success: false, error: "Project not found", code: 404 };
    }
    targetScope = requestedScope;
  } else if (isOrchestratorScopedSkill(normalizedName)) {
    targetScope = GLOBAL_PROJECT_ID;
  } else {
    // The card names the work in the user's own language; the id stays derived
    // from the skill so it is predictable on disk.
    const created = await createProject({
      id: await uniqueProjectId(normalizedName),
      name: skill.title || normalizedName,
      description: skill.summary || skill.description,
      instructions: `# ${skill.title || normalizedName}\n\n`,
      memoryMode: "global",
    });
    targetScope = created.id;
  }

  const installed = await installBundledSkill(targetScope, normalizedName);
  if (!installed.success && installed.code !== 409) {
    return { success: false, error: installed.error, code: installed.code };
  }

  return {
    success: true,
    skill,
    projectId: isOrchestratorScope(targetScope) ? null : targetScope,
    initialMessage: `/skill:${normalizedName}`,
  };
}
