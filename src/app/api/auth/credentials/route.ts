import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/storage/settings-store";
import { hashPassword } from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptionsForRequest,
  isRequestSecure,
  verifySessionToken,
} from "@/lib/auth/session";
import { getServerTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n/messages";

interface CredentialsBody {
  username?: unknown;
  password?: unknown;
}

function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePassword(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateUsername(username: string): MessageKey | null {
  if (username.length < 3) {
    return "api.error.usernameMin";
  }
  if (username.length > 64) {
    return "api.error.usernameMax";
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return "api.error.usernameInvalid";
  }
  return null;
}

function validatePassword(password: string): MessageKey | null {
  if (password.length < 8) {
    return "api.error.passwordMin";
  }
  if (password.length > 128) {
    return "api.error.passwordMax";
  }
  return null;
}

export async function PUT(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    return Response.json({ error: t("api.error.unauthorized") }, { status: 401 });
  }

  try {
    const body = (await req.json()) as CredentialsBody;
    const username = normalizeUsername(body.username);
    const password = normalizePassword(body.password);

    const usernameError = validateUsername(username);
    if (usernameError) {
      return Response.json({ error: t(usernameError) }, { status: 400 });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return Response.json({ error: t(passwordError) }, { status: 400 });
    }

    const current = await getSettings();
    await saveSettings({
      auth: {
        ...current.auth,
        username,
        passwordHash: hashPassword(password),
        mustChangeCredentials: false,
      },
    });

    const nextToken = await createSessionToken(username, false);
    const response = NextResponse.json({
      success: true,
      username,
      mustChangeCredentials: false,
    });
    response.cookies.set(
      AUTH_COOKIE_NAME,
      nextToken,
      getSessionCookieOptionsForRequest(isRequestSecure(req.url, req.headers))
    );
    return response;
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : t("api.error.updateCredentials"),
      },
      { status: 500 }
    );
  }
}
