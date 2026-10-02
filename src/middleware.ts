import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfigured, isValidSessionToken } from "@/lib/auth";

// Chemins accessibles sans session (en plus de /login lui-même, géré à part
// ci-dessous car son comportement dépend de l'état d'authentification).
const ALWAYS_PUBLIC = new Set([
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
  "/apple-touch-icon.png",
  "/logo.svg",
  "/logo.png",
  "/manifest.webmanifest",
]);
const ALWAYS_PUBLIC_PREFIXES = ["/icon-"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/api/auth/") ||
    ALWAYS_PUBLIC.has(pathname) ||
    ALWAYS_PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  if (!authConfigured()) {
    return new NextResponse(
      "Authentification non configurée : définis AUTH_USER et AUTH_PASSWORD dans les variables d'environnement (voir .env.example).",
      { status: 500 }
    );
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await isValidSessionToken(token);

  if (pathname === "/login") {
    if (authenticated) {
      const nextParam = req.nextUrl.searchParams.get("next") || "/";
      return NextResponse.redirect(new URL(nextParam, req.url));
    }
    return NextResponse.next();
  }

  if (authenticated) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
