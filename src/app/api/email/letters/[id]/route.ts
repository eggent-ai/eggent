import type { NextRequest } from "next/server";
import { fetchEmailMessage, markEmailRead } from "@/lib/email/client";
import { emailFailure, emailGuard, letterIdOf, NO_STORE } from "@/lib/email/route-helpers";

/**
 * One letter as it came. Opening a letter that came in marks it read. The text
 * is sent as text; the page draws it as text and never as markup.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refused = await emailGuard(req, { write: false });
  if (refused) return refused;
  const id = letterIdOf((await context.params).id);
  if (!id) return Response.json({ error: "No such letter.", code: "noMessage" }, { status: 404, headers: NO_STORE });
  try {
    const letter = await fetchEmailMessage(id);
    if (letter.direction === "in" && !letter.read) {
      await markEmailRead(letter.id).catch(() => undefined);
      letter.read = true;
    }
    return Response.json({ letter }, { headers: NO_STORE });
  } catch (error) {
    return emailFailure(error);
  }
}
