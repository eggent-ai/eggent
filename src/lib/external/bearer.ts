import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getExternalApiToken } from "@/lib/storage/external-api-token-store";

/**
 * The external API's own check, for a route other than /api/external/message:
 * the token made in Settings or the deployment's one, compared in constant time.
 * Answers the refusal to send back, or null when the caller may go on.
 */
export async function refuseExternalCaller(req: NextRequest): Promise<Response | null> {
  const storedToken = await getExternalApiToken();
  const envToken = process.env.EXTERNAL_API_TOKEN?.trim();
  if (!storedToken && !envToken) return Response.json({ error: "The external API has no token." }, { status: 503 });
  const header = req.headers.get("authorization") || "";
  const [scheme, provided] = header.trim().split(/\s+/, 2);
  const matches = (expected: string | null | undefined) => {
    if (!expected || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (scheme?.toLowerCase() !== "bearer" || ![storedToken, envToken].some(matches)) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="external-guest"' } });
  }
  return null;
}
