import type { NextRequest } from "next/server";
import { downloadMailAttachment } from "@/lib/mail/client";
import { mailFailure, mailGuard } from "@/lib/mail/route-helpers";
import { contentDisposition } from "@/lib/files/download-headers";

/**
 * A file of one of this workspace's threads, straight from the service: for a
 * file whose copy has not been taken here yet. Always a download, never shown
 * in place - it is somebody else's file.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refused = await mailGuard(req, { write: false });
  if (refused) return refused;
  const { id } = await context.params;
  try {
    const file = await downloadMailAttachment(id);
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
    return mailFailure(error);
  }
}
