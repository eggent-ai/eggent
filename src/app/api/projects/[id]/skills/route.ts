import { NextRequest, NextResponse } from "next/server";
import { getProject, loadProjectSkills } from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const skills = await loadProjectSkills(id);
    return NextResponse.json(
      skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        content: skill.body,
        license: skill.license,
        compatibility: skill.compatibility,
      }))
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to load project skills" },
      { status: 500 }
    );
  }
}
