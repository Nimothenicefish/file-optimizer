import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/paths";

const DB_PATH = path.join(DATA_DIR, "app.db");

declare global {
  var __db__: Database.Database | undefined;
}

// Ajoute une colonne à une table existante si elle n'y est pas déjà — pour
// une base déployée AVANT l'ajout de cette colonne (le CREATE TABLE IF NOT
// EXISTS ci-dessous ne modifie jamais une table déjà créée). Sans danger à
// rappeler à chaque démarrage : no-op si la colonne existe déjà.
function ensureColumn(instance: Database.Database, table: string, column: string, definition: string) {
  const columns = instance.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const instance = new Database(DB_PATH);
  instance.pragma("journal_mode = WAL");

  instance.exec(`
    -- Un job = un fichier (photo ou vidéo, voir "kind") à optimiser. Les
    -- réglages (dimension/qualité/conservation de l'original, CRF/preset/
    -- profil pour une vidéo) sont stockés sur chaque job plutôt que globalement :
    -- un lot lancé avec certains réglages reste traçable et reproductible
    -- même si les réglages par défaut changent ensuite. Pour une vidéo,
    -- keep_original = conserver la source renommée en .mkv.bkp.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      max_dimension INTEGER NOT NULL,
      quality INTEGER NOT NULL,
      keep_original INTEGER NOT NULL DEFAULT 1,
      force_jpeg INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'image',
      video_crf INTEGER,
      video_preset TEXT,
      video_profile TEXT,
      -- Avancement (0-100) d'un encodage vidéo en cours ; NULL pour une photo.
      progress REAL,
      -- Annulation demandée pour un job "running" (voir cancelJobs dans
      -- src/lib/queue/jobs.ts) : le worker la détecte pendant le traitement
      -- et l'interrompt.
      cancel_requested INTEGER NOT NULL DEFAULT 0,
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

    -- Une seule ligne (id=1) : quand paused=1, le worker (voir tick() dans
    -- src/lib/queue/worker.ts) ne démarre plus aucun NOUVEAU job, mais laisse
    -- un job déjà "running" se terminer normalement — bouton pause/reprise
    -- sur /jobs. Persisté en base : survit à un redémarrage du conteneur.
    CREATE TABLE IF NOT EXISTS queue_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_file_path ON jobs(file_path);
  `);

  ensureColumn(instance, "jobs", "force_jpeg", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(instance, "jobs", "kind", "TEXT NOT NULL DEFAULT 'image'");
  ensureColumn(instance, "jobs", "video_crf", "INTEGER");
  ensureColumn(instance, "jobs", "video_preset", "TEXT");
  ensureColumn(instance, "jobs", "video_profile", "TEXT");
  ensureColumn(instance, "jobs", "progress", "REAL");
  ensureColumn(instance, "jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");

  instance
    .prepare(
      "INSERT OR IGNORE INTO login_attempts (id, failed_count, last_failed_at) VALUES (1, 0, NULL)"
    )
    .run();

  instance.prepare("INSERT OR IGNORE INTO queue_settings (id, paused) VALUES (1, 0)").run();

  return instance;
}

export const db = globalThis.__db__ ?? (globalThis.__db__ = createDb());
