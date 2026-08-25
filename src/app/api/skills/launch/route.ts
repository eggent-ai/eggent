import { NextRequest, NextResponse } from "next/server";
import { launchBundledSkill } from "@/lib/storage/bundled-skills-store";
import { getServerLocale } from "@/i18n/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    skillName?: unknown;
    projectId?: unknown;
  } | null;
  const skillName = typeof body?.skillName === "string" ? body.skillName.trim() : "";
  // Left out on purpose from a quick-start card: the skill then decides its own
  // home - its own project for a piece of work, the orchestrator for the skills
  // that describe the workspace itself. A caller that already knows the target,
  // like a project's skills screen, passes it and that wins.
  const projectId = typeof body?.projectId === "string" && body.projectId.trim()
    ? body.projectId.trim()
    : undefined;

  if (!skillName) {
    return NextResponse.json({ error: "skillName is required" }, { status: 400 });
  }

  // Card copy and the routing note are written in the workspace's language,
  // which only the request knows.
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const result = await launchBundledSkill(skillName, projectId, locale);
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
