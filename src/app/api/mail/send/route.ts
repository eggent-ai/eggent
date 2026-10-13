import path from "path";
import type { NextRequest } from "next/server";
import { sendMailMessage, type MailFileUpload } from "@/lib/mail/client";
import { MAIL_MAX_FILES, MAIL_MAX_FILE_BYTES, readFilesForMail } from "@/lib/mail/outgoing";
import { mailFailure, mailGuard, NO_STORE } from "@/lib/mail/route-helpers";
import { syncMailAttachments } from "@/lib/mail/sync";
import { getWorkDir } from "@/lib/storage/project-store";

/** What one message may carry, with room for the form around it. */
const MAX_REQUEST_BYTES = MAIL_MAX_FILES * MAIL_MAX_FILE_BYTES + 1024 * 1024;

/**
 * Sends a message to one contact, as the person (written in Messages) or as
 * their agent (an answer sent with the button under it). Two shapes:
 *
 * - multipart, from the Messages screen: `to`, `text`, `replyTo`, and the files
 *   the person attached from their computer;
 * - JSON, from a chat: `to`, `text`, `replyTo`, `author`, and `files` naming
 *   files of this workspace as `{ project, path }` - the ones an answer made.
 */
export async function POST(req: NextRequest) {
  const multipart = /^multipart\/form-data\b/i.test(req.headers.get("content-type") || "");
  const refused = await mailGuard(req, { write: true, body: multipart ? "multipart" : "json" });
  if (refused) return refused;
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) {
    return Response.json({ error: `A message can carry at most ${MAIL_MAX_FILES} files of up to ${MAIL_MAX_FILE_BYTES / 1024 / 1024} MB.`, code: "messageTooLarge" }, { status: 413, headers: NO_STORE });
  }
  try {
    let to = "";
    let text = "";
    let replyTo: number | null = null;
    let author: "person" | "agent" = "person";
    let files: MailFileUpload[] = [];
    if (multipart) {
      const form = await req.formData();
      to = String(form.get("to") || "");
      text = String(form.get("text") || "");
      replyTo = Number(form.get("replyTo") || 0) || null;
      const uploads = form.getAll("files").filter((entry): entry is File => typeof entry === "object" && entry !== null && "arrayBuffer" in entry);
      if (uploads.length > MAIL_MAX_FILES) {
        return Response.json({ error: `At most ${MAIL_MAX_FILES} files go with one message.`, code: "tooManyFiles" }, { status: 400, headers: NO_STORE });
      }
      files = await Promise.all(uploads.map(async (file) => ({ name: file.name, mime: file.type || undefined, data: Buffer.from(await file.arrayBuffer()) })));
    } else {
      const body = (await req.json().catch(() => ({}))) as {
        to?: unknown; text?: unknown; replyTo?: unknown; author?: unknown; files?: unknown;
      };
      to = typeof body.to === "string" ? body.to : "";
      text = typeof body.text === "string" ? body.text : "";
      replyTo = Number(body.replyTo || 0) || null;
      author = body.author === "agent" ? "agent" : "person";
      const named = Array.isArray(body.files) ? body.files : [];
      const paths = named.flatMap((entry) => {
        const file = (entry && typeof entry === "object" ? entry : {}) as { project?: unknown; path?: unknown };
        if (typeof file.path !== "string" || !file.path) return [];
        const project = typeof file.project === "string" && file.project ? file.project : "none";
        try {
          return [path.join(getWorkDir(project), file.path)];
        } catch {
          return [];
        }
      });
      if (paths.length !== named.length) {
        return Response.json({ error: "A file to send is not one of this workspace's.", code: "badFile" }, { status: 400, headers: NO_STORE });
      }
      const read = await readFilesForMail(paths);
      if ("error" in read) return Response.json({ error: read.error, code: "badFile" }, { status: 400, headers: NO_STORE });
      files = read.files;
    }
    const message = await sendMailMessage({ to, text, replyTo, author, files });
    // This workspace's own copy of what it sent goes into its Messages folder too.
    if (message.attachments.length) void syncMailAttachments().catch(() => undefined);
    return Response.json({ message }, { headers: NO_STORE });
  } catch (error) {
    return mailFailure(error);
  }
}
