import fs from "fs/promises";
import path from "path";
import {
  getProject,
  getProjectSkillsDir,
  validateSkillName,
} from "@/lib/storage/project-store";

const SKILL_FILE_NAME = "SKILL.md";
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), "bundled-skills");

export interface BundledSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
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
  fallbackName: string
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

  return {
    name,
    description,
    license: frontmatter.license?.trim() || undefined,
    compatibility: frontmatter.compatibility?.trim() || undefined,
  };
}

export async function listBundledSkills(): Promise<BundledSkill[]> {
  try {
    const entries = await fs.readdir(BUNDLED_SKILLS_DIR, {
      withFileTypes: true,
    });
    const result: BundledSkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = await readBundledSkillFromDir(
        path.join(BUNDLED_SKILLS_DIR, entry.name),
        entry.name
      );
      if (skill) result.push(skill);
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
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

  const project = await getProject(projectId);
  if (!project) {
    return { success: false, error: "Project not found", code: 404 };
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
      error: `Skill "${normalizedName}" is already installed in this project`,
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
