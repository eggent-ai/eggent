import { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey, MessageValues } from "@/i18n/messages";
import { formatUploadSize } from "@/lib/files/upload-limits";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { SKILL_ISSUE_MESSAGES, SKILL_NOTE_MESSAGES, type SkillIssue } from "@/lib/skills/issues";
import { SKILL_ARCHIVE_MAX_BYTES } from "@/lib/skills/limits";
import { checkSkillUpload } from "@/lib/skills/upload-check";
import { installUploadedSkill } from "@/lib/skills/upload-install";
import { getProject, isOrchestratorScope } from "@/lib/storage/project-store";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

/**
 * Upload one skill - a SKILL.md, or a .zip / .skill archive - into the
 * orchestrator or a project.
 *
 * A skill is read by the agent as instructions and may carry scripts it runs, so
 * a write here is a write into the agent's behaviour. It wants what the shell
 * and learning routes want: a signed-in session of this site, and a request that
 * did not come from another page. The body is a form, because a file is, and the
 * guard says so.
 *
 * One file per request. The page sends several in turn, which gives each its own
 * answer and keeps a bad one from costing the others.
 *
 * Nothing is written unless every check passed, and a write that fails partway
 * is removed - see upload-install.ts.
 */

/** A request is the file plus a little form overhead. */
const MAX_REQUEST_BYTES = SKILL_ARCHIVE_MAX_BYTES + 1024 * 1024;

type Translate = (key: MessageKey, values?: MessageValues) => string;

function failure(status: number, code: string, messages: string[]): Response {
  return Response.json(
    { ok: false, code, error: messages[0], problems: messages },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function describe(t: Translate, issue: SkillIssue): string {
  return t(SKILL_ISSUE_MESSAGES[issue.code], issue.params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await checkTerminalRequest(req, { write: true, body: "multipart" });
  if (guard) return jsonError("Not allowed.", guardStatus(guard));

  const t = await getServerTranslator(req.headers.get("accept-language"));

  // The size is read from the header before the body is touched, for the reason
  // the file upload route gives: a body past the limit is already cut off, and
  // parsing it would report a malformed form instead of how big is too big.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return failure(413, "tooLarge", [
      t("skills.upload.error.tooLarge", {
        size: formatUploadSize(declared),
        limit: formatUploadSize(SKILL_ARCHIVE_MAX_BYTES),
      }),
    ]);
  }

  const { id } = await params;
  if (!isOrchestratorScope(id) && !(await getProject(id))) {
    return failure(404, "projectNotFound", [t("skills.upload.error.projectNotFound")]);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return failure(400, "badRequest", [t("skills.upload.error.badRequest")]);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return failure(400, "noFile", [t("skills.upload.error.noFile")]);
  const replace = form.get("replace") === "1";

  const checked = await checkSkillUpload({ fileName: file.name, data: Buffer.from(await file.arrayBuffer()) });
  if (!checked.ok) {
    const [first] = checked.issues;
    return failure(
      first.code === "tooLarge" ? 413 : 422,
      first.code,
      checked.issues.map((issue) => describe(t, issue))
    );
  }

  const { skill } = checked;
  const installed = await installUploadedSkill(id, skill, { replace });
  if (!installed.ok) {
    return installed.code === "exists"
      ? failure(409, "exists", [t("skills.upload.error.exists", { skill: skill.name })])
      : failure(500, "writeFailed", [t("skills.upload.error.writeFailed")]);
  }

  publishUiSyncEvent({
    topic: "files",
    projectId: isOrchestratorScope(id) ? null : id,
    reason: "skill_uploaded",
  });

  return Response.json(
    {
      ok: true,
      skill: skill.name,
      description: skill.description,
      replaced: installed.replaced,
      keptAs: installed.keptAs ? `skills/${installed.keptAs}` : null,
      files: skill.files.length,
      notes: skill.notes.map((note) => t(SKILL_NOTE_MESSAGES[note])),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
