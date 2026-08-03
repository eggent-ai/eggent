import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

function isPublicPage(pathname: string): boolean {
  return pathname === "/login";
}

function isPublicApi(req: NextRequest, pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  if (pathname === "/api/auth/status") return true;
  if (pathname === "/api/external/message") return true;
  if (pathname === "/api/external/media-message") return true;
  if (pathname === "/api/integrations/telegram" && req.method === "POST") {
    return true;
  }
  return false;
}

function shouldBypass(pathname: string): boolean {
  if (/\.[^/]+$/.test(pathname)) {
    return true;
  }
  if (
    pathname.startsWith("/_next/static") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return true;
  }
  return false;
}

function buildLoginRedirect(req: NextRequest): NextResponse {
  const loginUrl = new URL("/login", req.url);
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next && next !== "/") {
    loginUrl.searchParams.set("next", next);
  }
  return NextResponse.redirect(loginUrl);
}

const ONBOARDING_PATH = "/dashboard/onboarding";

function buildCredentialsOnboardingRedirect(req: NextRequest): NextResponse {
  return NextResponse.redirect(new URL(ONBOARDING_PATH, req.url));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (shouldBypass(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/") && isPublicApi(req, pathname)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifySessionToken(token) : null;

  if (isPublicPage(pathname)) {
    if (session) {
      if (session.mustChangeCredentials) {
        return buildCredentialsOnboardingRedirect(req);
      }
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return buildLoginRedirect(req);
  }

  // Until the default login is replaced there is exactly one page to be on.
  if (session.mustChangeCredentials && pathname.startsWith("/dashboard") && pathname !== ONBOARDING_PATH) {
    return buildCredentialsOnboardingRedirect(req);
  }

  // And once it is replaced, that page has nothing left to do.
  if (!session.mustChangeCredentials && pathname === ONBOARDING_PATH) {
    return NextResponse.redirect(new URL("/dashboard/settings", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
