import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings, SessionEndedError } from "@/lib/storage/settings-store";
import { hashPassword } from "@/lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  getSessionCookieOptionsForRequest,
  isRequestSecure,
} from "@/lib/auth/session";
import { forgetSessionFloorCache, sessionFloorNow, verifyActiveSession } from "@/lib/auth/session-floor";
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

// A login is either a plain name or an email address: a hosted workspace's is
// the address it was created with, and refusing the "@" in it left nobody
// there able to change their password from Settings.
function validateUsername(username: string): MessageKey | null {
  if (username.length < 3) {
    return "api.error.usernameMin";
  }
  if (username.includes("@")) {
    if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
      return "api.error.usernameEmailInvalid";
    }
    return null;
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
  const session = token ? await verifyActiveSession(token) : null;
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

    // A new password ends every other session: whoever else knew the old one,
    // or held a browser signed in with it, is out. This browser gets a session
    // of its own below, issued after the moment written here.
    // Checked again inside the write: a session ended by a reset that lands
    // while this one waits does not get to choose the password after it.
    const current = await getSettings();
    try {
      await saveSettings({
        auth: {
          ...current.auth,
          username,
          passwordHash: hashPassword(password),
          mustChangeCredentials: false,
          sessionsValidAfter: sessionFloorNow(),
        },
      }, { sessionIssuedAt: session.issuedAt });
    } catch (error) {
      if (error instanceof SessionEndedError) {
        return Response.json({ error: t("api.error.unauthorized") }, { status: 401 });
      }
      throw error;
    }
    forgetSessionFloorCache();

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
