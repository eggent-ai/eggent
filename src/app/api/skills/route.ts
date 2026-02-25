import { NextRequest, NextResponse } from "next/server";
import { loadProjectSkillsMetadata } from "@/lib/storage/project-store";
import {
  installBundledSkill,
  listBundledSkills,
} from "@/lib/storage/bundled-skills-store";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const bundledSkills = await listBundledSkills();

  if (!projectId) {
    return NextResponse.json(
      bundledSkills.map((skill) => ({ ...skill, installed: false }))
    );
  }

  try {
    const installedSkills = await loadProjectSkillsMetadata(projectId);
    const installedNames = new Set(
      installedSkills.map((skill) => skill.name.toLowerCase())
    );

    return NextResponse.json(
      bundledSkills.map((skill) => ({
        ...skill,
        installed: installedNames.has(skill.name.toLowerCase()),
      }))
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to load installed project skills" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId =
    typeof body === "object" &&
    body !== null &&
    "projectId" in body &&
    typeof body.projectId === "string"
      ? body.projectId
      : "";
  const skillName =
    typeof body === "object" &&
    body !== null &&
    "skillName" in body &&
    typeof body.skillName === "string"
      ? body.skillName
      : "";

  if (!projectId.trim() || !skillName.trim()) {
    return NextResponse.json(
      { error: "projectId and skillName are required" },
      { status: 400 }
    );
  }

  const result = await installBundledSkill(projectId, skillName);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.code });
  }

  return NextResponse.json(
    {
      success: true,
      installedSkill: skillName.trim().toLowerCase(),
      targetDir: result.targetDir,
    },
    { status: 201 }
  );
}
