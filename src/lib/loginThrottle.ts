// Ralentit les tentatives de connexion après plusieurs échecs consécutifs
// (délai croissant, jusqu'à 15 min) — protège contre le bruteforce du mot de
// passe. Compteur global stocké en base (une seule paire identifiant/mot de
// passe pour toute l'app), pour survivre aux redémarrages du conteneur.
//
// Dépend de better-sqlite3 (via @/lib/db) : n'importer ce module que depuis
// du code tournant en runtime Node.js (ex: la route API de login), jamais
// depuis src/lib/auth.ts ni le middleware, qui doivent rester compatibles
// Edge.
import { db } from "@/lib/db";

const FREE_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 15 * 60;

type Row = { failed_count: number; last_failed_at: string | null };

function getRow(): Row {
  return db
    .prepare("SELECT failed_count, last_failed_at FROM login_attempts WHERE id = 1")
    .get() as Row;
}

// SQLite datetime('now') renvoie "YYYY-MM-DD HH:MM:SS" (UTC, sans séparateur
// "T" ni suffixe) — à convertir en ISO 8601 avant de le passer à Date().
function parseSqliteDatetime(value: string): number {
  return new Date(`${value.replace(" ", "T")}Z`).getTime();
}

function requiredDelaySeconds(failedCount: number): number {
  if (failedCount <= FREE_ATTEMPTS) return 0;
  const over = failedCount - FREE_ATTEMPTS;
  return Math.min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * 2 ** (over - 1));
}

export function checkLoginThrottle(): { blocked: boolean; retryAfterSeconds: number } {
  const row = getRow();
  if (!row.last_failed_at) return { blocked: false, retryAfterSeconds: 0 };

  const delay = requiredDelaySeconds(row.failed_count);
  if (delay === 0) return { blocked: false, retryAfterSeconds: 0 };

  const elapsedSeconds = (Date.now() - parseSqliteDatetime(row.last_failed_at)) / 1000;
  const remaining = Math.ceil(delay - elapsedSeconds);
  if (remaining <= 0) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: remaining };
}

export function recordFailedLogin(): void {
  db.prepare(
    "UPDATE login_attempts SET failed_count = failed_count + 1, last_failed_at = datetime('now') WHERE id = 1"
  ).run();
}

export function recordSuccessfulLogin(): void {
  db.prepare(
    "UPDATE login_attempts SET failed_count = 0, last_failed_at = NULL WHERE id = 1"
  ).run();
}
