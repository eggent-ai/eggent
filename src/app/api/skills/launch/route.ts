import { NextRequest, NextResponse } from "next/server";
import { launchBundledSkill } from "@/lib/storage/bundled-skills-store";
import { GLOBAL_PROJECT_ID } from "@/lib/storage/project-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    skillName?: unknown;
    projectId?: unknown;
  } | null;
  const skillName = typeof body?.skillName === "string" ? body.skillName.trim() : "";
  // No target means the orchestrator: that is where a workspace with no
  // projects starts, and where a skill stays available in every chat.
  const projectId = typeof body?.projectId === "string" && body.projectId.trim()
    ? body.projectId.trim()
    : GLOBAL_PROJECT_ID;

  if (!skillName) {
    return NextResponse.json({ error: "skillName is required" }, { status: 400 });
  }

  const result = await launchBundledSkill(skillName, projectId);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: result.code });
  }

  return NextResponse.json({
    success: true,
    skill: result.skill,
    projectId: result.projectId,
    scope: result.projectId ? "project" : "orchestrator",
    initialMessage: result.initialMessage,
  }, { status: 201 });
}
