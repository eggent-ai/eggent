import type { NextRequest } from "next/server";
import { fetchEmailList } from "@/lib/email/client";
import { emailFailure, emailGuard, NO_STORE } from "@/lib/email/route-helpers";
import { rememberLetters } from "@/lib/email/store";

const FOLDERS = new Set(["inbox", "other", "sent"]);

/** One folder of the mailbox, newest first: inbox (default), other or sent. */
export async function GET(req: NextRequest) {
  const refused = await emailGuard(req, { write: false });
  if (refused) return refused;
  const folder = req.nextUrl.searchParams.get("folder") || "inbox";
  if (!FOLDERS.has(folder)) return Response.json({ error: "No such folder.", code: "noFolder" }, { status: 400, headers: NO_STORE });
  try {
    const letters = await fetchEmailList({ folder, limit: 100 });
    // What the person has looked at is what the agent's list knows too.
    await rememberLetters(letters).catch(() => undefined);
    return Response.json({ folder, letters }, { headers: NO_STORE });
  } catch (error) {
    return emailFailure(error);
  }
}
