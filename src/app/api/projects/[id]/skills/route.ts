import { NextRequest, NextResponse } from "next/server";
import { learnedSkillsView } from "@/lib/learning/usage";
import { getProject, isOrchestratorScope, loadProjectSkillsMetadata, loadProjectSkills } from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isOrchestratorScope(id)) {
    const project = await getProject(id);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  }

  try {
    const skills = await loadProjectSkills(id);
    // Which of them the agent wrote itself, and which it has stopped using.
    const learned = new Set((await loadProjectSkillsMetadata(id)).filter((skill) => skill.learned).map((skill) => skill.name));
    const stale = new Set(
      learned.size > 0 && isOrchestratorScope(id)
        ? (await learnedSkillsView()).skills.filter((skill) => skill.state === "stale").map((skill) => skill.name)
        : []
    );
    return NextResponse.json(
      skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.body,
        license: skill.license,
        compatibility: skill.compatibility,
        ...(learned.has(skill.name) ? { learned: true } : {}),
        ...(stale.has(skill.name) ? { stale: true } : {}),
      }))
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to load workspace skills" },
      { status: 500 }
    );
  }
}
