import { NextResponse } from "next/server";
import { SESSION_COOKIE, authConfigured, checkCredentials, createSessionToken } from "@/lib/auth";
import { checkLoginThrottle, recordFailedLogin, recordSuccessfulLogin } from "@/lib/loginThrottle";

export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json({ error: "Authentification non configurée" }, { status: 500 });
  }

  const throttle = checkLoginThrottle();
  if (throttle.blocked) {
    return NextResponse.json(
      { error: `Trop de tentatives échouées — réessaie dans ${throttle.retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!checkCredentials(username, password)) {
    recordFailedLogin();
    return NextResponse.json({ error: "Identifiant ou mot de passe incorrect" }, { status: 401 });
  }

  recordSuccessfulLogin();

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token!, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Pas de "secure: true" forcé : beaucoup de déploiements self-hosted
    // (NAS, LAN) tournent en HTTP simple sans reverse-proxy TLS — le cookie
    // ne serait alors jamais envoyé et la connexion échouerait toujours.
    maxAge: 60 * 60 * 24 * 30, // 30 jours
  });
  return res;
}
