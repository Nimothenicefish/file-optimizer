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
      -- Début/fin réels du traitement (epoch ms, horloge du serveur) : base
      -- des estimations de temps restant (voir src/lib/eta.ts). Mesurés par
      -- job plutôt que depuis le début du lot : une pause de la file ne
      -- fausse pas l'estimation.
      started_at INTEGER,
      finished_at INTEGER,
      -- Pause d'un job vidéo en cours (process ffmpeg gelé, voir
      -- src/lib/queue/worker.ts) : paused_at = début de la pause actuelle
      -- (NULL hors pause), paused_ms = cumul des pauses terminées — retirés
      -- du temps écoulé dans les estimations.
      paused_at INTEGER,
      paused_ms INTEGER NOT NULL DEFAULT 0,
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
    -- src/lib/queue/worker.ts) ne démarre plus aucun NOUVEAU job, et gèle un
    -- encodage vidéo en cours (repris là où il en était) ; une photo en
    -- cours (quelques secondes) se termine normalement — bouton
    -- pause/reprise sur /jobs. Persisté en base : survit à un redémarrage
    -- du conteneur.
    CREATE TABLE IF NOT EXISTS queue_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0
    );

    -- Bilan cumulé par type de média (voir src/lib/stats.ts) : mis à jour à
    -- chaque job terminé, indépendant de l'historique des jobs — supprimer
    -- les jobs terminés ne fait pas perdre le total d'espace gagné.
    CREATE TABLE IF NOT EXISTS stats (
      kind TEXT PRIMARY KEY,
      processed INTEGER NOT NULL DEFAULT 0,
      optimized INTEGER NOT NULL DEFAULT 0,
      original_bytes INTEGER NOT NULL DEFAULT 0,
      saved_bytes INTEGER NOT NULL DEFAULT 0
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
  ensureColumn(instance, "jobs", "started_at", "INTEGER");
  ensureColumn(instance, "jobs", "finished_at", "INTEGER");
  ensureColumn(instance, "jobs", "paused_at", "INTEGER");
  ensureColumn(instance, "jobs", "paused_ms", "INTEGER NOT NULL DEFAULT 0");

  instance
    .prepare(
      "INSERT OR IGNORE INTO login_attempts (id, failed_count, last_failed_at) VALUES (1, 0, NULL)"
    )
    .run();

  instance.prepare("INSERT OR IGNORE INTO queue_settings (id, paused) VALUES (1, 0)").run();

  // Base déployée avant l'ajout du bilan : initialisé une seule fois (table
  // vide) à partir des jobs terminés encore présents.
  const statsEmpty =
    (instance.prepare("SELECT COUNT(*) AS c FROM stats").get() as { c: number }).c === 0;
  if (statsEmpty) {
    instance.exec(`
      INSERT INTO stats (kind, processed, optimized, original_bytes, saved_bytes)
      SELECT k.kind,
             COUNT(j.id),
             COALESCE(SUM(j.optimized_size < j.original_size), 0),
             COALESCE(SUM(CASE WHEN j.optimized_size < j.original_size THEN j.original_size END), 0),
             COALESCE(SUM(CASE WHEN j.optimized_size < j.original_size
                               THEN j.original_size - j.optimized_size END), 0)
      FROM (SELECT 'image' AS kind UNION ALL SELECT 'video') k
      LEFT JOIN jobs j ON j.kind = k.kind AND j.status = 'done'
      GROUP BY k.kind
    `);
  }

  return instance;
}

export const db = globalThis.__db__ ?? (globalThis.__db__ = createDb());
