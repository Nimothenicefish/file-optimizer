import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/paths";

const DB_PATH = path.join(DATA_DIR, "app.db");

declare global {
  var __db__: Database.Database | undefined;
}

function createDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const instance = new Database(DB_PATH);
  instance.pragma("journal_mode = WAL");

  instance.exec(`
    -- Un job = une photo à optimiser. Les réglages (dimension/qualité/
    -- conservation de l'original) sont stockés sur chaque job plutôt que
    -- globalement : un lot lancé avec certains réglages reste traçable et
    -- reproductible même si les réglages par défaut changent ensuite.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      max_dimension INTEGER NOT NULL,
      quality INTEGER NOT NULL,
      keep_original INTEGER NOT NULL DEFAULT 1,
      original_size INTEGER,
      optimized_size INTEGER,
      error TEXT,
      log TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Une seule ligne (id=1) : compteur global de tentatives de connexion
    -- échouées consécutives, pour ralentir le bruteforce du mot de passe
    -- (une seule paire identifiant/mot de passe pour toute l'app).
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      failed_count INTEGER NOT NULL DEFAULT 0,
      last_failed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_file_path ON jobs(file_path);
  `);

  instance
    .prepare(
      "INSERT OR IGNORE INTO login_attempts (id, failed_count, last_failed_at) VALUES (1, 0, NULL)"
    )
    .run();

  return instance;
}

export const db = globalThis.__db__ ?? (globalThis.__db__ = createDb());
