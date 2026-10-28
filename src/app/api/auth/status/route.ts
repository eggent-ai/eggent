import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import { isDefaultAuthCredentials } from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  getClearedSessionCookieOptions,
  isRequestSecure,
} from "@/lib/auth/session";
import { verifyActiveSession } from "@/lib/auth/session-floor";

/**
 * Where a lost password is reset, when somebody set one up for this workspace
 * (a hosted deployment sends a letter; a self-hosted one has none, and the
 * sign-in page then says how a password is changed there). Public, like the
 * rest of this answer: the sign-in page asks before anybody is signed in.
 */
function passwordResetUrl(): string | null {
  const raw = process.env.EGGENT_PASSWORD_RESET_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifyActiveSession(token) : null;
  if (!session) {
    const response = NextResponse.json(
      { authenticated: false, username: null, mustChangeCredentials: false, passwordResetUrl: passwordResetUrl() },
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
    passwordResetUrl: passwordResetUrl(),
  });
}
