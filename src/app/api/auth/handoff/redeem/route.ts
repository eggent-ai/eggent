import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import { isDefaultAuthCredentials } from "@/lib/auth/password";
import { redeemHandoffToken } from "@/lib/auth/handoff";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptionsForRequest,
  isRequestSecure,
} from "@/lib/auth/session";
import { getServerTranslator } from "@/i18n/server";

/**
 * Spends a one-time sign-in link and starts the same session a password would.
 *
 * Public, like the sign-in endpoint: the token is the credential. It is spent
 * on the first attempt whatever happens next, and it signs in only if the
 * workspace still has the login it was minted for - a link that outlived a
 * change of login is refused rather than honoured for somebody else.
 */
export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const redeemed = redeemHandoffToken(body?.token);
  if (!redeemed) {
    return Response.json({ error: t("api.error.handoffInvalid") }, { status: 401 });
  }

  const settings = await getSettings();
  if (!settings.auth.enabled) {
    return Response.json({ error: t("api.error.authDisabled") }, { status: 403 });
  }
  if (settings.auth.username !== redeemed.username) {
    return Response.json({ error: t("api.error.handoffInvalid") }, { status: 401 });
  }

  const mustChangeCredentials = isDefaultAuthCredentials(
    settings.auth.username,
    settings.auth.passwordHash
  );
  const session = await createSessionToken(redeemed.username, mustChangeCredentials);
  const response = NextResponse.json({ success: true, mustChangeCredentials });
  response.cookies.set(
    AUTH_COOKIE_NAME,
    session,
    getSessionCookieOptionsForRequest(isRequestSecure(req.url, req.headers))
  );
  return response;
}
