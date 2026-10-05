import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

export type JobKind = "image" | "video";

export type EnqueueParams = {
  filePath: string; // chemin absolu réel sur disque
  kind: JobKind;
  maxDimension: number;
  quality: number;
  // Photo : déplacer l'original dans origin/. Vidéo : conserver la source
  // renommée en .mkv.bkp.
  keepOriginal: boolean;
  forceJpeg: boolean;
  videoCrf: number;
  videoPreset: string;
  videoProfile: string;
};

export type EnqueueOutcome = { queued: number; skippedAlreadyQueued: number; ids: string[] };

// Met en file un lot de fichiers (photos et/ou vidéos). Ignore (sans
// erreur) tout fichier ayant déjà un job "pending"/"running" — relancer un
// scan sur un dossier dont le traitement précédent n'est pas terminé ne doit
// pas créer de doublons.
export function enqueueFiles(files: EnqueueParams[]): EnqueueOutcome {
  const existsActive = db.prepare(
    "SELECT id FROM jobs WHERE file_path = ? AND status IN ('pending', 'running')"
  );
  const insert = db.prepare(
    `INSERT INTO jobs (id, file_path, kind, status, max_dimension, quality, keep_original, force_jpeg,
                       video_crf, video_preset, video_profile)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
  );

  let queued = 0;
  let skippedAlreadyQueued = 0;
  const ids: string[] = [];

  for (const file of files) {
    if (existsActive.get(file.filePath)) {
      skippedAlreadyQueued++;
      continue;
    }
    const id = randomUUID();
    const isVideo = file.kind === "video";
    insert.run(
      id,
      file.filePath,
      file.kind,
      file.maxDimension,
      file.quality,
      file.keepOriginal ? 1 : 0,
      file.forceJpeg ? 1 : 0,
      isVideo ? file.videoCrf : null,
      isVideo ? file.videoPreset : null,
      isVideo ? file.videoProfile : null
    );
    ids.push(id);
    queued++;
  }

  return { queued, skippedAlreadyQueued, ids };
}

export function hasActiveJob(filePath: string): boolean {
  return !!db
    .prepare("SELECT id FROM jobs WHERE file_path = ? AND status IN ('pending', 'running')")
    .get(filePath);
}

export type CancelOutcome = { cancelled: number; cancelling: number };

// Annule des jobs : un job "pending" passe directement à "cancelled" ; un job
// "running" est seulement marqué cancel_requested — c'est le worker qui
// interrompt le traitement en cours puis le passe à "cancelled" (voir
// processJob dans src/lib/queue/worker.ts), une fois le fichier remis dans
// un état sûr.
export function cancelJobs(ids: string[]): CancelOutcome {
  const cancelPending = db.prepare(
    "UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  );
  const requestCancel = db.prepare(
    "UPDATE jobs SET cancel_requested = 1, updated_at = datetime('now') WHERE id = ? AND status = 'running'"
  );
  let cancelled = 0;
  let cancelling = 0;
  for (const id of ids) {
    cancelled += cancelPending.run(id).changes;
    cancelling += requestCancel.run(id).changes;
  }
  return { cancelled, cancelling };
}

export function isCancelRequested(jobId: string): boolean {
  const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(jobId) as
    | { cancel_requested: number }
    | undefined;
  return row?.cancel_requested === 1;
}

export function deletePendingJobs(): number {
  return db.prepare("DELETE FROM jobs WHERE status = 'pending'").run().changes;
}

export function deleteDoneJobs(): number {
  return db.prepare("DELETE FROM jobs WHERE status = 'done'").run().changes;
}

export function deleteCancelledJobs(): number {
  return db.prepare("DELETE FROM jobs WHERE status = 'cancelled'").run().changes;
}

// Supprime des jobs précis de l'historique — jamais un job en attente ou en
// cours (à annuler d'abord), ignorés sans erreur. Ne touche à aucun fichier.
export function deleteJobs(ids: string[]): number {
  const del = db.prepare("DELETE FROM jobs WHERE id = ? AND status NOT IN ('pending', 'running')");
  let changed = 0;
  for (const id of ids) {
    changed += del.run(id).changes;
  }
  return changed;
}
