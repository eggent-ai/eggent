import type { NextRequest } from "next/server";
import { downloadEmailAttachment } from "@/lib/email/client";
import { contentDisposition } from "@/lib/files/download-headers";
import { emailFailure, emailGuard, letterIdOf, NO_STORE } from "@/lib/email/route-helpers";

/**
 * A file that came with a letter. Always a download, never shown in place:
 * somebody outside chose what it holds.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string; n: string }> }) {
  const refused = await emailGuard(req, { write: false });
  if (refused) return refused;
  const params = await context.params;
  const id = letterIdOf(params.id);
  const n = /^\d{1,2}$/.test(params.n) ? Number(params.n) : null;
  if (!id || n === null) return Response.json({ error: "No such file.", code: "noAttachment" }, { status: 404, headers: NO_STORE });
  try {
    const file = await downloadEmailAttachment(id, n);
    return new Response(new Uint8Array(file.data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition("attachment", file.name),
        "Content-Length": String(file.data.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return emailFailure(error);
  }
}
