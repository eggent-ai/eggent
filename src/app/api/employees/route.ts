import { NextRequest } from "next/server";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";
import { getServerLocale } from "@/i18n/server";
import { listBundledSkills } from "@/lib/storage/bundled-skills-store";
import { getAllProjects } from "@/lib/storage/project-store";

/** The employees one can hire here, and the ones already hired (their projects). */
export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not available.", guardStatus(failure));
  const locale = await getServerLocale(req.headers.get("accept-language"));
  const skills = (await listBundledSkills(locale)).filter((skill) => skill.employee);
  const projects = (await getAllProjects()).filter((project) => project.employee);
  return Response.json(
    {
      available: skills.map((skill) => ({ skill: skill.name, order: skill.order, ...skill.employee })).sort((a, b) => a.order - b.order),
      hired: projects.map((project) => ({ projectId: project.id, name: project.name, employee: project.employee, createdAt: project.createdAt })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
