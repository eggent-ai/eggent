import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { mintHandoffToken } from "@/lib/auth/handoff";

/**
 * Mints a one-time sign-in link for the user of the session that asks.
 *
 * The middleware already refuses this route without a session; the check is
 * repeated here because the link signs in as whoever this session belongs to.
 * The token travels in the fragment of the path returned, which browsers never
 * send to a server, so it stays out of every access log on the way.
 */
export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = cookie ? await verifySessionToken(cookie) : null;
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token, expiresAt } = mintHandoffToken(session.username);
  return Response.json(
    {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      path: `/login#handoff=${token}`,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
