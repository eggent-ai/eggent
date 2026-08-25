/**
 * Stands in for the project store in tests.
 *
 * The real module drags in the chat store and the app's type module, which is
 * more than any of these tests need and more than Node's type stripping can
 * load. What is here is real behaviour on a real temporary directory, not a
 * recording: projects are written to and read from disk, so a test can assert
 * that a project appeared rather than that a spy was called.
 */
import fs from "fs/promises";
import path from "path";

export const GLOBAL_PROJECT_ID = "none";

interface StubProject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  memoryMode: "global" | "isolated";
  createdAt: string;
  updatedAt: string;
}

function projectsDir(): string {
  return path.join(process.cwd(), "data", "projects");
}

function projectDir(projectId: string): string {
  const resolved = path.resolve(projectsDir(), projectId);
  if (path.dirname(resolved) !== path.resolve(projectsDir())) {
    throw new Error(`Project id "${projectId}" escapes the projects directory.`);
  }
  return resolved;
}

export function isOrchestratorScope(projectId: string | null | undefined): boolean {
  return !projectId || projectId === GLOBAL_PROJECT_ID;
}

export function getWorkDir(projectId: string | null): string {
  return projectId ? path.join(projectsDir(), projectId) : process.cwd();
}

export function getProjectSkillsDir(projectId: string): string {
  return isOrchestratorScope(projectId)
    ? path.join(projectsDir(), "skills")
    : path.join(projectDir(projectId), "skills");
}

export function validateSkillName(skillName: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) {
    return "Skill name must be lowercase letters, digits and hyphens.";
  }
  return null;
}

export async function getProject(projectId: string): Promise<StubProject | null> {
  if (!projectId || isOrchestratorScope(projectId)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir(projectId), "project.json"), "utf-8"));
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<StubProject[]> {
  const entries = await fs.readdir(projectsDir(), { withFileTypes: true }).catch(() => []);
  const projects: StubProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await getProject(entry.name);
    if (project) projects.push(project);
  }
  return projects;
}

export async function createProject(
  project: Omit<StubProject, "createdAt" | "updatedAt">
): Promise<StubProject> {
  if (isOrchestratorScope(project.id)) {
    throw new Error(`Project id "${project.id}" is reserved for the orchestrator.`);
  }
  const now = new Date().toISOString();
  const full: StubProject = { ...project, createdAt: now, updatedAt: now };
  await fs.mkdir(getProjectSkillsDir(project.id), { recursive: true });
  await fs.writeFile(path.join(projectDir(project.id), "context.md"), project.instructions || `# ${project.name}\n\n`);
  await fs.writeFile(path.join(projectDir(project.id), "project.json"), JSON.stringify(full, null, 2));
  return full;
}

export async function loadProjectModelSettings(): Promise<null> {
  return null;
}
