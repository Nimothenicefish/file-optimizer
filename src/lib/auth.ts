// Authentification par session (cookie signé) — utilise Web Crypto
// (crypto.subtle), disponible aussi bien dans le runtime Edge (middleware)
// que Node.js — évite toute dépendance à node:crypto, indisponible sur Edge.

export const SESSION_COOKIE = "optimize_files_session";

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// AUTH_SECRET est optionnel : à défaut on signe avec AUTH_PASSWORD, ce qui a
// l'avantage d'invalider automatiquement toutes les sessions existantes si le
// mot de passe est changé.
function sessionSecret(): string | null {
  const password = process.env.AUTH_PASSWORD;
  if (!password) return null;
  return process.env.AUTH_SECRET || password;
}

export function authConfigured(): boolean {
  return !!(process.env.AUTH_USER && process.env.AUTH_PASSWORD);
}

export function checkCredentials(username: string, password: string): boolean {
  return username === process.env.AUTH_USER && password === process.env.AUTH_PASSWORD;
}

export async function createSessionToken(): Promise<string | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  return hmacHex(secret, `session:${process.env.AUTH_USER}`);
}

export async function isValidSessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const expected = await createSessionToken();
  return expected !== null && token === expected;
}
