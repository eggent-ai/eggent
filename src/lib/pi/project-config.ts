import path from "path";
import {
  GLOBAL_PROJECT_ID,
  getProject,
  getProjectContextPath,
  getProjectMcpServersPath,
  getProjectMemoryPath,
  getProjectSkillsDir,
  getWorkDir,
  loadProjectMcpServers,
  loadProjectSkillsMetadata,
  readProjectContext,
} from "@/lib/storage/project-store";

export async function getEggentPiProjectConfig(projectId?: string | null) {
  const project = projectId ? await getProject(projectId) : null;
  // The orchestrator is a workspace too: same four files, resolved from its own
  // working directory instead of a project directory.
  const scopeId = projectId ?? GLOBAL_PROJECT_ID;
  const cwd = getWorkDir(scopeId);
  const skills = await loadProjectSkillsMetadata(scopeId);
  const mcp = await loadProjectMcpServers(scopeId);
  const instructions = project ? project.instructions || "" : await readProjectContext(scopeId);

  return {
    projectId: projectId || null,
    project,
    pi: {
      cwd,
      contextFile: getProjectContextPath(scopeId),
      instructions,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        skillDir: skill.skillDir,
        skillFile: path.join(skill.skillDir, "SKILL.md"),
      })),
      mcpServers: mcp?.servers ?? [],
      memoryFile: getProjectMemoryPath(scopeId),
      files: {
        context: getProjectContextPath(scopeId),
        memory: getProjectMemoryPath(scopeId),
        skills: getProjectSkillsDir(scopeId),
        mcp: getProjectMcpServersPath(scopeId),
        model: path.join(cwd, "model.json"),
      },
      bridgeTools: [
        "eggent_memory_search",
        "eggent_memory_save",
        "eggent_memory_delete",
        "mcp",
        "web_search",
        "fetch_content",
        "get_search_content",
        "eggent_list_pipelines",
        "eggent_start_pipeline",
      ],
    },
  };
}
