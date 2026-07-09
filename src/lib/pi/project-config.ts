import path from "path";
import {
  getProject,
  getWorkDir,
  loadProjectMcpServers,
  loadProjectSkillsMetadata,
} from "@/lib/storage/project-store";

export async function getEggentPiProjectConfig(projectId?: string | null) {
  const project = projectId ? await getProject(projectId) : null;
  const cwd = projectId ? getWorkDir(projectId) : getWorkDir(null);
  const skills = projectId ? await loadProjectSkillsMetadata(projectId) : [];
  const mcp = projectId ? await loadProjectMcpServers(projectId) : null;
  const memoryFile = projectId ? path.join(cwd, "memory.md") : null;

  return {
    projectId: projectId || null,
    project,
    pi: {
      cwd,
      contextFile: projectId
        ? path.join(cwd, "context.md")
        : path.join(cwd, "EGGENT_GLOBAL_CONTEXT.md"),
      instructions: project?.instructions || "",
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        skillDir: skill.skillDir,
        skillFile: path.join(skill.skillDir, "SKILL.md"),
      })),
      mcpServers: mcp?.servers ?? [],
      memoryFile,
      files: {
        context: path.join(cwd, "context.md"),
        memory: path.join(cwd, "memory.md"),
        skills: path.join(cwd, "skills"),
        mcp: path.join(cwd, "mcp.json"),
        cron: path.join(cwd, "cron.json"),
        model: path.join(cwd, "model.json"),
      },
      bridgeTools: [
        "eggent_memory_search",
        "eggent_memory_save",
        "eggent_memory_delete",
        "eggent_mcp_*",
        "eggent_list_pipelines",
        "eggent_start_pipeline",
      ],
    },
  };
}
