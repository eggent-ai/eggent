import type { NextRequest } from "next/server";
import { markMailThreadRead } from "@/lib/mail/client";
import { mailFailure, mailGuard, NO_STORE } from "@/lib/mail/route-helpers";

/** The person has seen the conversation with this contact, up to a message or all of it. */
export async function POST(req: NextRequest) {
  const refused = await mailGuard(req, { write: true });
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { with?: unknown; upTo?: unknown };
  try {
    const upTo = Number(body.upTo);
    return Response.json(
      await markMailThreadRead(typeof body.with === "string" ? body.with : "", Number.isFinite(upTo) && upTo > 0 ? upTo : undefined),
      { headers: NO_STORE }
    );
  } catch (error) {
    return mailFailure(error);
  }
}
