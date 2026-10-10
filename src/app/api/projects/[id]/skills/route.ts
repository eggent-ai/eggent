import { NextRequest, NextResponse } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { learnedSkillsView } from "@/lib/learning/usage";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import {
  deleteSkill,
  getProject,
  isOrchestratorScope,
  loadProjectSkillsMetadata,
  loadProjectSkills,
} from "@/lib/storage/project-store";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

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

/**
 * Delete one skill - its folder, and the earlier versions kept when an upload
 * replaced it - from the orchestrator or a project.
 *
 * It removes what the agent reads as instructions and may run as scripts, so it
 * wants what writing one does (see upload/route.ts): a signed-in session of this
 * site and a request that did not come from another page. The name rides in a
 * JSON body rather than the address, because a skill may be called `upload` and
 * so share its last segment with the route that takes files.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await checkTerminalRequest(req, { write: true });
  if (guard) return jsonError("Not allowed.", guardStatus(guard));

  const t = await getServerTranslator(req.headers.get("accept-language"));
  const refuse = (status: number, code: string, error: string) =>
    NextResponse.json({ ok: false, code, error }, { status, headers: { "Cache-Control": "no-store" } });

  const { id } = await params;
  if (!isOrchestratorScope(id) && !(await getProject(id))) {
    return refuse(404, "projectNotFound", t("api.error.projectNotFound"));
  }

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return refuse(400, "noName", t("skills.delete.error.noName"));

  const result = await deleteSkill(id, name);
  if (!result.success) {
    if (result.code === "invalid-name") return refuse(400, "invalidName", t("skills.delete.error.invalidName", { name: name.slice(0, 80) }));
    if (result.code === "not-found") return refuse(404, "notFound", t("skills.delete.error.notFound", { skill: name.slice(0, 80) }));
    console.error(`Failed to delete the skill "${name}":`, result.error);
    return refuse(500, "failed", t("skills.delete.error.failed"));
  }

  publishUiSyncEvent({
    topic: "files",
    projectId: isOrchestratorScope(id) ? null : id,
    reason: "skill_deleted",
  });

  return NextResponse.json(
    { ok: true, skill: name, versionsRemoved: result.versionsRemoved },
    { headers: { "Cache-Control": "no-store" } }
  );
}
