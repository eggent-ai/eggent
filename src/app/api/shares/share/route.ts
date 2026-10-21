import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { absoluteInScope } from "@/lib/files/project-keys";
import { shareOwnFile, type ShareFailure } from "@/lib/shares/files";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";
import { SHARE_MAX_FILE_BYTES, SHARE_MAX_PEOPLE, SHARE_ROLES, type ShareRole } from "@/lib/shares/types";

/**
 * Shares a file of this workspace, or changes who has it:
 *
 *   POST /api/shares/share  { project, path, people: [{ id, role }] }  ->  { share }
 *
 * The list given is everybody who has the file from now on; an empty list
 * keeps the share and takes it from everyone (stopping is /api/shares/<id>/stop).
 */
const STATUS: Record<ShareFailure, number> = { outside: 403, missing: 404, notFile: 400, sensitive: 400, tooLarge: 413 };

export async function POST(req: NextRequest) {
  const refused = await sharesGuard(req, { write: true });
  if (refused) return refused;
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { project?: unknown; path?: unknown; people?: unknown } | null;
  const project = typeof body?.project === "string" ? body.project.trim() : "";
  const filePath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!project || !filePath) return Response.json({ error: t("api.error.projectIdAndFilePathRequired") }, { status: 400, headers: NO_STORE });
  const people: Array<{ id: string; role: ShareRole }> = [];
  for (const entry of Array.isArray(body?.people) ? body.people.slice(0, SHARE_MAX_PEOPLE + 1) : []) {
    const person = (entry && typeof entry === "object" ? entry : {}) as { id?: unknown; role?: unknown };
    if (typeof person.id !== "string" || !person.id.trim() || !SHARE_ROLES.includes(person.role as ShareRole)) {
      return Response.json({ error: t("shares.error.badPerson"), code: "badRole" }, { status: 400, headers: NO_STORE });
    }
    people.push({ id: person.id.trim(), role: person.role as ShareRole });
  }
  const absolute = absoluteInScope(project, filePath);
  if (!absolute) return Response.json({ error: t("shares.error.outside"), code: "outside" }, { status: 403, headers: NO_STORE });
  try {
    const shared = await shareOwnFile({ absolute, people });
    if ("error" in shared) {
      return Response.json({ error: t(`shares.error.${shared.error}`, { maxMb: SHARE_MAX_FILE_BYTES / 1024 / 1024 }), code: shared.error }, { status: STATUS[shared.error], headers: NO_STORE });
    }
    return Response.json({ share: shared.share }, { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
