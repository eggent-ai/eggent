import { NextRequest, NextResponse } from "next/server";
import { createProjectWithBundledSkill } from "@/lib/storage/bundled-skills-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { skillName?: unknown } | null;
  const skillName = typeof body?.skillName === "string" ? body.skillName.trim() : "";

  if (!skillName) {
    return NextResponse.json({ error: "skillName is required" }, { status: 400 });
  }

  const result = await createProjectWithBundledSkill(skillName);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.code });
  }

  return NextResponse.json({
    success: true,
    project: result.project,
    skill: result.skill,
    initialMessage: result.initialMessage,
  }, { status: 201 });
}
