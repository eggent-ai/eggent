import type { NextRequest } from "next/server";
import { fetchSharePeople } from "@/lib/shares/client";
import { NO_STORE, sharesFailure, sharesGuard } from "@/lib/shares/route-helpers";

/** Everybody in the company a file can be shared with: GET /api/shares/people. */
export async function GET(req: NextRequest) {
  const refused = await sharesGuard(req, { write: false });
  if (refused) return refused;
  try {
    return Response.json(await fetchSharePeople(), { headers: NO_STORE });
  } catch (error) {
    return sharesFailure(error);
  }
}
