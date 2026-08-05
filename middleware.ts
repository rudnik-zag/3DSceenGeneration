import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token"
];

function hasSessionCookie(req: NextRequest) {
  return SESSION_COOKIE_NAMES.some((name) => Boolean(req.cookies.get(name)?.value));
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isUnsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const isWebhook = pathname === "/api/billing/webhook";
  if (pathname.startsWith("/api/") && isUnsafeMethod && !isWebhook) {
    const origin = req.headers.get("origin");
    const fetchSite = req.headers.get("sec-fetch-site");
    if ((origin && origin !== req.nextUrl.origin) || fetchSite === "cross-site") {
      return NextResponse.json(
        { error: "invalid_origin", message: "Cross-site request rejected" },
        { status: 403 }
      );
    }
  }
  const authenticated = hasSessionCookie(req);
  const protectedPrefixes = ["/app", "/billing", "/settings"];

  if (protectedPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    if (!authenticated) {
      const next = encodeURIComponent(`${pathname}${search}`);
      return NextResponse.redirect(new URL(`/login?next=${next}`, req.url));
    }
    return NextResponse.next();
  }

  if ((pathname === "/login" || pathname === "/register") && authenticated) {
    return NextResponse.redirect(new URL("/app", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/app/:path*", "/billing/:path*", "/settings/:path*", "/login", "/register"]
};
