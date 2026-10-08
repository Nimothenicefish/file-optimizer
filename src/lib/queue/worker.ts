import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { db } from "@/lib/db";
import { optimizeImage } from "@/lib/pipeline/optimizeImage";
import { optimizeVideo, partPathFor } from "@/lib/pipeline/optimizeVideo";
import { isCancelRequested } from "@/lib/queue/jobs";
import { isQueuePaused } from "@/lib/queueSettings";
import { recordJobStats } from "@/lib/stats";
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

// Fréquence de vérification d'une demande d'annulation ou d'une pause du job
// en cours (voir cancelJobs et setQueuePaused) — lues en base plutôt que
// transmises en mémoire : la route API et le worker ne partagent pas
// forcément la même instance de module.
const SUPERVISE_INTERVAL_MS = 1000;

// Pause d'un encodage vidéo en cours : le process ffmpeg/ffprobe est gelé
// (SIGSTOP) puis repris (SIGCONT) exactement là où il en était — rien n'est
// perdu ni réécrit, ffmpeg ne voit pas la différence, et la vérification
// finale habituelle tourne toujours avant de remplacer la source. Il garde
// sa mémoire pendant la pause (CPU à 0). Une photo en cours n'est pas gelée :
// elle se termine en quelques secondes.
class VideoFreezer {
  private child: ChildProcess | null = null;
  private frozen = false;

  constructor(private readonly jobId: string) {}

  // Branché sur onProcess d'optimizeVideo : un process lancé pendant une
  // pause (étape suivante : vérification...) est gelé aussitôt.
  readonly track = (child: ChildProcess | null) => {
    this.child = child;
    if (child && this.frozen) child.kill("SIGSTOP");
  };

  sync(paused: boolean) {
    if (paused === this.frozen) return;
    this.frozen = paused;
    const now = Date.now();
    if (paused) {
      this.child?.kill("SIGSTOP");
      db.prepare("UPDATE jobs SET paused_at = ? WHERE id = ?").run(now, this.jobId);
      appendLog(this.jobId, "mis en pause (encodage gelé, reprendra là où il en est)");
    } else {
      this.child?.kill("SIGCONT");
      this.endPause(now);
      appendLog(this.jobId, "repris");
    }
  }

  // Comptabilise la pause en cours dans paused_ms (reprise, ou fin du job).
  endPause(now = Date.now()) {
    db.prepare(
      "UPDATE jobs SET paused_ms = paused_ms + (? - paused_at), paused_at = NULL WHERE id = ? AND paused_at IS NOT NULL"
    ).run(now, this.jobId);
  }
}

function runOptimization(job: JobRow, signal: AbortSignal, freezer: VideoFreezer) {
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
      onProcess: freezer.track,
      onProgress,
      onPercent: (percent) => {
        const now = Date.now();
        // 100 % toujours écrit : marque la fin de l'encodage (début de la
        // vérification) pour l'affichage, quel que soit le dernier envoi.
        if (percent < 100 && now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
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

// Toujours un statut terminal (done/error/cancelled) : horodate la fin.
function setStatus(jobId: string, status: string, error?: string) {
  db.prepare(
    "UPDATE jobs SET status = ?, error = ?, finished_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, error ?? null, Date.now(), jobId);
}

// Job en cours de traitement (un seul à la fois), pour la remise en attente
// sur arrêt du conteneur (voir requeueOnShutdown).
let current: { job: JobRow; controller: AbortController } | null = null;
// Arrêt du conteneur en cours : plus aucun job ne démarre, et celui qui
// s'interrompt ne se marque pas lui-même en erreur/annulé (il vient d'être
// remis en attente).
let shuttingDown = false;

async function processJob(job: JobRow) {
  db.prepare(
    "UPDATE jobs SET status = 'running', started_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(Date.now(), job.id);

  const controller = new AbortController();
  current = { job, controller };
  const freezer = new VideoFreezer(job.id);
  const supervise = setInterval(() => {
    // Annulation possible même pendant une pause : SIGKILL arrête aussi un
    // process gelé.
    if (isCancelRequested(job.id)) controller.abort();
    else if (job.kind === "video") freezer.sync(isQueuePaused());
  }, SUPERVISE_INTERVAL_MS);

  try {
    if (!fs.existsSync(job.file_path)) {
      throw new Error("Fichier introuvable (déplacé ou supprimé depuis la mise en file).");
    }

    const result = await runOptimization(job, controller.signal, freezer);
    if (shuttingDown) return;

    db.prepare(
      "UPDATE jobs SET original_size = ?, optimized_size = ?, file_path = ? WHERE id = ?"
    ).run(result.originalSize, result.optimizedSize, result.finalPath, job.id);
    appendLog(
      job.id,
      result.optimizedSize === result.originalSize
        ? `inchangé (${result.originalSize} octets)`
        : `optimisé : ${result.originalSize} -> ${result.optimizedSize} octets`
    );
    if (result.finalPath !== job.file_path) {
      appendLog(job.id, `converti en JPG : ${result.finalPath}`);
    }
    setStatus(job.id, "done");
    recordJobStats(job.kind === "video" ? "video" : "image", result.originalSize, result.optimizedSize);
  } catch (err) {
    if (shuttingDown) return;
    if (controller.signal.aborted) {
      appendLog(job.id, "ANNULÉ : traitement interrompu à la demande, fichier d'origine intact.");
      setStatus(job.id, "cancelled");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    appendLog(job.id, `ERREUR: ${message}`);
    setStatus(job.id, "error", message);
  } finally {
    clearInterval(supervise);
    if (!shuttingDown) freezer.endPause();
    current = null;
  }
}

// Arrêt propre du conteneur (SIGTERM : déploiement, docker stop, redémarrage
// du NAS) : le job en cours est interrompu (ffmpeg tué, photo abandonnée
// avant écriture — voir les signal d'annulation des pipelines) et remis en
// attente, pour reprendre automatiquement au démarrage suivant — depuis le
// début pour une vidéo (ffmpeg ne sait pas reprendre un encodage à moitié
// fait). Synchrone : s'exécute entièrement avant que Next ne quitte. Un
// plantage (mémoire saturée : SIGKILL, aucun gestionnaire) laisse lui le job
// "running", passé en erreur au démarrage (voir recoverInterruptedJobs) —
// pour ne jamais relancer en boucle une vidéo qui fait planter le conteneur.
export function requeueOnShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!current) return;
  const { job, controller } = current;
  controller.abort();
  const partPath = partPathFor(job.file_path);
  if (job.kind === "video" && fs.existsSync(partPath)) fs.unlinkSync(partPath);
  db.prepare(
    `UPDATE jobs SET status = 'pending', started_at = NULL, progress = NULL, paused_at = NULL,
                     paused_ms = 0, cancel_requested = 0, updated_at = datetime('now')
     WHERE id = ? AND status = 'running'`
  ).run(job.id);
  appendLog(
    job.id,
    "remis en attente : arrêt du conteneur (reprendra depuis le début au prochain démarrage)"
  );
}

let running = false;

async function tick() {
  if (running || shuttingDown) return;
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
  // Gestionnaires synchrones, appelés avant la sortie (asynchrone) de Next
  // sur ces mêmes signaux.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      requeueOnShutdown();
      // Écouter un signal désactive la terminaison par défaut de Node : sans
      // autre écouteur (process sans serveur Next, ex: tests), on quitte nous-
      // mêmes avec le code standard (128 + numéro du signal).
      if (process.listenerCount(signal) === 1) process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  setInterval(() => {
    tick().catch((err) => console.error("Erreur worker:", err));
  }, 1000);
}
