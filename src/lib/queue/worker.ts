import fs from "node:fs";
import { db } from "@/lib/db";
import { optimizeImage } from "@/lib/pipeline/optimizeImage";
import { optimizeVideo, partPathFor } from "@/lib/pipeline/optimizeVideo";
import { isCancelRequested } from "@/lib/queue/jobs";
import { isQueuePaused } from "@/lib/queueSettings";
import {
  DEFAULT_VIDEO_CRF,
  DEFAULT_VIDEO_PRESET,
  DEFAULT_VIDEO_PROFILE,
  isVideoProfile,
} from "@/lib/videoSettings";

export { enqueueFiles } from "@/lib/queue/jobs";

type JobRow = {
  id: string;
  file_path: string;
  status: string;
  max_dimension: number;
  quality: number;
  keep_original: number;
  force_jpeg: number;
  kind: string;
  video_crf: number | null;
  video_preset: string | null;
  video_profile: string | null;
};

// Écritures en base de l'avancement d'un encodage vidéo espacées d'au moins
// ce délai (ffmpeg le rapporte plusieurs fois par seconde, inutile d'écrire
// aussi souvent pour un affichage rafraîchi toutes les 3s).
const PROGRESS_WRITE_INTERVAL_MS = 3000;

// Fréquence de vérification d'une demande d'annulation du job en cours (voir
// cancelJobs) — lue en base plutôt que transmise en mémoire : la route API
// et le worker ne partagent pas forcément la même instance de module.
const CANCEL_POLL_INTERVAL_MS = 1000;

function runOptimization(job: JobRow, signal: AbortSignal) {
  const onProgress = (msg: string) => appendLog(job.id, msg);

  if (job.kind === "video") {
    let lastWrite = 0;
    return optimizeVideo({
      filePath: job.file_path,
      crf: job.video_crf ?? DEFAULT_VIDEO_CRF,
      preset: job.video_preset ?? DEFAULT_VIDEO_PRESET,
      profile: isVideoProfile(job.video_profile) ? job.video_profile : DEFAULT_VIDEO_PROFILE,
      keepSource: job.keep_original === 1,
      signal,
      onProgress,
      onPercent: (percent) => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
        lastWrite = now;
        db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(percent, job.id);
      },
    });
  }

  return optimizeImage({
    filePath: job.file_path,
    maxDimension: job.max_dimension,
    quality: job.quality,
    keepOriginal: job.keep_original === 1,
    forceJpeg: job.force_jpeg === 1,
    signal,
    onProgress,
  });
}

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

  const controller = new AbortController();
  const cancelPoll = setInterval(() => {
    if (isCancelRequested(job.id)) controller.abort();
  }, CANCEL_POLL_INTERVAL_MS);

  try {
    if (!fs.existsSync(job.file_path)) {
      throw new Error("Fichier introuvable (déplacé ou supprimé depuis la mise en file).");
    }

    const result = await runOptimization(job, controller.signal);

    db.prepare(
      "UPDATE jobs SET original_size = ?, optimized_size = ?, file_path = ? WHERE id = ?"
    ).run(result.originalSize, result.optimizedSize, result.finalPath, job.id);
    appendLog(job.id, `optimisé : ${result.originalSize} -> ${result.optimizedSize} octets`);
    if (result.finalPath !== job.file_path) {
      appendLog(job.id, `converti en JPG : ${result.finalPath}`);
    }
    setStatus(job.id, "done");
  } catch (err) {
    if (controller.signal.aborted) {
      appendLog(job.id, "ANNULÉ : traitement interrompu à la demande, fichier d'origine intact.");
      setStatus(job.id, "cancelled");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    appendLog(job.id, `ERREUR: ${message}`);
    setStatus(job.id, "error", message);
  } finally {
    clearInterval(cancelPoll);
  }
}

let running = false;

async function tick() {
  if (running) return;
  // Un job déjà "running" continue : la pause ne fait qu'empêcher d'en
  // DÉMARRER un nouveau (pour l'interrompre, l'annuler — voir cancelJobs).
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
  const stuck = db
    .prepare("SELECT id, file_path, kind FROM jobs WHERE status = 'running'")
    .all() as Array<{ id: string; file_path: string; kind: string }>;

  for (const job of stuck) {
    // Encodage vidéo coupé en plein milieu : le fichier temporaire
    // (incomplet) traînerait sinon à côté de la source, qui elle n'a jamais
    // été touchée (remplacée seulement à la toute fin).
    const partPath = partPathFor(job.file_path);
    if (job.kind === "video" && fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }
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
