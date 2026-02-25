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

function validateUsername(username: string): string | null {
  if (username.length < 3) {
    return "Username must be at least 3 characters.";
  }
  if (username.length > 64) {
    return "Username must be at most 64 characters.";
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return "Username may contain only letters, numbers, dots, underscores, and hyphens.";
  }
  return null;
}

function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 128) {
    return "Password must be at most 128 characters.";
  }
  return null;
}

export async function PUT(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as CredentialsBody;
    const username = normalizeUsername(body.username);
    const password = normalizePassword(body.password);

    const usernameError = validateUsername(username);
    if (usernameError) {
      return Response.json({ error: usernameError }, { status: 400 });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return Response.json({ error: passwordError }, { status: 400 });
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
        error: error instanceof Error ? error.message : "Failed to update credentials.",
      },
      { status: 500 }
    );
  }
}
