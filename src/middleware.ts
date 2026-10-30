import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth/session";
import { verifyActiveSession } from "@/lib/auth/session-floor";

function isPublicPage(pathname: string): boolean {
  return pathname === "/login";
}

function isPublicApi(req: NextRequest, pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  if (pathname === "/api/auth/status") return true;
  // The one-time sign-in link is the credential; minting one still needs a session.
  if (pathname === "/api/auth/handoff/redeem") return true;
  // A page shown in a sandboxed frame carries no cookie; its token is checked by the route.
  if (pathname.startsWith("/api/files/page/")) return true;
  if (pathname.startsWith("/api/shares/page/")) return true;
  if (pathname === "/api/external/message") return true;
  if (pathname === "/api/external/media-message") return true;
  if (pathname === "/api/external/guest") return true;
  if (pathname === "/api/external/telegram/sent" && req.method === "POST") return true;
  if (pathname === "/api/external/kb/warm" && req.method === "POST") return true;
  if (pathname === "/api/integrations/telegram" && req.method === "POST") {
    return true;
  }
  return false;
}

function shouldBypass(pathname: string): boolean {
  // A file at the top of the site: the icons and robots.txt. Anything deeper
  // is one of the app's own routes whatever its last segment looks like - a
  // dot there used to let a request past the sign-in check, a session ended by
  // a new password included, to every API route that leans on this check.
  if (/^\/[^/]+\.[^/]+$/.test(pathname)) {
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

  // A public link to a project: its page and its own routes, open to anybody;
  // each route finds the link and the visitor itself (lib/public-chat).
  if (pathname.startsWith("/s/")) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  const session = token ? await verifyActiveSession(token) : null;

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

// On Node rather than the edge: a session issued before the last change of
// password is refused here, and only the settings file says when that was.
export const config = {
  runtime: "nodejs",
  matcher: ["/:path*"],
};
