import fs from "node:fs";
import { db } from "@/lib/db";
import { optimizeImage } from "@/lib/pipeline/optimizeImage";
import { isQueuePaused } from "@/lib/queueSettings";

export { enqueuePhotos } from "@/lib/queue/jobs";

type JobRow = {
  id: string;
  file_path: string;
  status: string;
  max_dimension: number;
  quality: number;
  keep_original: number;
};

function appendLog(jobId: string, line: string) {
  db.prepare(
    "UPDATE jobs SET log = log || ? || char(10), updated_at = datetime('now') WHERE id = ?"
  ).run(line, jobId);
}

function setStatus(jobId: string, status: string, error?: string) {
  db.prepare(
    "UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, error ?? null, jobId);
}

async function processJob(job: JobRow) {
  db.prepare("UPDATE jobs SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(
    job.id
  );

  try {
    if (!fs.existsSync(job.file_path)) {
      throw new Error("Fichier introuvable (déplacé ou supprimé depuis la mise en file).");
    }

    const result = await optimizeImage({
      filePath: job.file_path,
      maxDimension: job.max_dimension,
      quality: job.quality,
      keepOriginal: job.keep_original === 1,
      onProgress: (msg) => appendLog(job.id, msg),
    });

    db.prepare("UPDATE jobs SET original_size = ?, optimized_size = ? WHERE id = ?").run(
      result.originalSize,
      result.optimizedSize,
      job.id
    );
    appendLog(
      job.id,
      `optimisé : ${result.originalSize} -> ${result.optimizedSize} octets`
    );
    setStatus(job.id, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLog(job.id, `ERREUR: ${message}`);
    setStatus(job.id, "error", message);
  }
}

let running = false;

async function tick() {
  if (running) return;
  // Un job déjà "running" continue (rien ne l'interrompt) : la pause ne fait
  // qu'empêcher d'en DÉMARRER un nouveau.
  if (isQueuePaused()) return;
  const job = db
    .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
    .get() as JobRow | undefined;
  if (!job) return;

  running = true;
  try {
    await processJob(job);
  } finally {
    running = false;
  }
}

// Un job resté "running" au démarrage n'a pas pu se terminer normalement (le
// conteneur a été tué en plein traitement). Jamais repris automatiquement
// (tick() ne regarde que les jobs "pending") — marqué "error" plutôt que
// remis "pending" pour éviter une boucle de crash si c'est le traitement
// lui-même qui a fait planter le conteneur (ex: photo démesurée).
export function recoverInterruptedJobs() {
  const stuck = db.prepare("SELECT id FROM jobs WHERE status = 'running'").all() as Array<{
    id: string;
  }>;

  for (const job of stuck) {
    appendLog(
      job.id,
      "ERREUR: interrompu par un redémarrage du conteneur — relance manuellement si besoin."
    );
    setStatus(job.id, "error", "Traitement interrompu par un redémarrage du conteneur.");
  }
}

declare global {
  var __queueStarted__: boolean | undefined;
}

// Traitement séquentiel (1 job à la fois), persisté en base donc les jobs
// "pending" survivent à un redémarrage.
export function startWorker() {
  if (globalThis.__queueStarted__) return;
  globalThis.__queueStarted__ = true;
  recoverInterruptedJobs();
  setInterval(() => {
    tick().catch((err) => console.error("Erreur worker:", err));
  }, 1000);
}
