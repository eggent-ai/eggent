import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  getClearedSessionCookieOptions,
  isRequestSecure,
} from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(
    AUTH_COOKIE_NAME,
    "",
    getClearedSessionCookieOptions(isRequestSecure(req.url, req.headers))
  );
  return response;
}
