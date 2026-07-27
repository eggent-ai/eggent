import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/storage/settings-store";
import {
  isDefaultAuthCredentials,
  verifyPassword,
} from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptionsForRequest,
  isRequestSecure,
} from "@/lib/auth/session";
import { getServerTranslator } from "@/i18n/server";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = (await req.json()) as LoginBody;
    const username = toTrimmedString(body.username);
    const password = toTrimmedString(body.password);

    if (!username || !password) {
      return Response.json(
        { error: t("api.error.usernamePasswordRequired") },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    if (!settings.auth.enabled) {
      return Response.json(
        { error: t("api.error.authDisabled") },
        { status: 403 }
      );
    }

    const userMatches = username === settings.auth.username;
    const passwordMatches = verifyPassword(password, settings.auth.passwordHash);
    if (!userMatches || !passwordMatches) {
      return Response.json({ error: t("api.error.invalidCredentials") }, { status: 401 });
    }

    const mustChangeCredentials = isDefaultAuthCredentials(
      settings.auth.username,
      settings.auth.passwordHash
    );
    const token = await createSessionToken(username, mustChangeCredentials);
    const response = NextResponse.json({
      success: true,
      mustChangeCredentials,
    });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      token,
      getSessionCookieOptionsForRequest(isRequestSecure(req.url, req.headers))
    );
    return response;
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : t("api.error.loginFailed"),
      },
      { status: 500 }
    );
  }
}
