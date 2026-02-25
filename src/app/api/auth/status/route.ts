import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import { isDefaultAuthCredentials } from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  getClearedSessionCookieOptions,
  isRequestSecure,
  verifySessionToken,
} from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    const response = NextResponse.json(
      { authenticated: false, username: null, mustChangeCredentials: false },
      { status: 401 }
    );
    if (token) {
      response.cookies.set(
        AUTH_COOKIE_NAME,
        "",
        getClearedSessionCookieOptions(isRequestSecure(req.url, req.headers))
      );
    }
    return response;
  }

  const settings = await getSettings();
  const mustChangeCredentials =
    session.mustChangeCredentials ||
    isDefaultAuthCredentials(settings.auth.username, settings.auth.passwordHash);
  return Response.json({
    authenticated: true,
    username: session.username,
    mustChangeCredentials,
  });
}
