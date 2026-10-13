import type { NextRequest } from "next/server";
import { fetchMailThread } from "@/lib/mail/client";
import { mailFailure, mailGuard, NO_STORE } from "@/lib/mail/route-helpers";
import { lacksCopies, syncMailAttachments, withLocalCopies } from "@/lib/mail/sync";

/** How long a thread waits for its files to be copied here before it answers without them. */
const COPY_WAIT_MS = 4_000;

/** The conversation with one person; each file says where its copy is here, once there is one. */
export async function GET(req: NextRequest) {
  const refused = await mailGuard(req, { write: false });
  if (refused) return refused;
  const contactId = req.nextUrl.searchParams.get("with") || "";
  const before = Number(req.nextUrl.searchParams.get("before") || 0) || undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") || 0) || undefined;
  try {
    const thread = await fetchMailThread(contactId, { before, limit });
    let messages = await withLocalCopies(thread.messages);
    if (lacksCopies(messages)) {
      // Someone is looking at these files now: copy them rather than wait for the next round.
      await Promise.race([syncMailAttachments().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, COPY_WAIT_MS))]);
      messages = await withLocalCopies(thread.messages);
    }
    return Response.json({ ...thread, messages }, { headers: NO_STORE });
  } catch (error) {
    return mailFailure(error);
  }
}
