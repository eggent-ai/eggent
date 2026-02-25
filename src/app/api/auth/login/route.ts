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

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LoginBody;
    const username = toTrimmedString(body.username);
    const password = toTrimmedString(body.password);

    if (!username || !password) {
      return Response.json(
        { error: "Username and password are required." },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    if (!settings.auth.enabled) {
      return Response.json(
        { error: "Authentication is disabled." },
        { status: 403 }
      );
    }

    const userMatches = username === settings.auth.username;
    const passwordMatches = verifyPassword(password, settings.auth.passwordHash);
    if (!userMatches || !passwordMatches) {
      return Response.json({ error: "Invalid credentials." }, { status: 401 });
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
        error: error instanceof Error ? error.message : "Login failed.",
      },
      { status: 500 }
    );
  }
}
