import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

export type EnqueueParams = {
  filePath: string; // chemin absolu réel sur disque
  maxDimension: number;
  quality: number;
  keepOriginal: boolean;
  forceJpeg: boolean;
};

export type EnqueueOutcome = { queued: number; skippedAlreadyQueued: number; ids: string[] };

// Met en file un lot de photos. Ignore (sans erreur) tout fichier ayant déjà
// un job "pending"/"running" — relancer un scan sur un dossier dont le
// traitement précédent n'est pas terminé ne doit pas créer de doublons.
export function enqueuePhotos(photos: EnqueueParams[]): EnqueueOutcome {
  const existsActive = db.prepare(
    "SELECT id FROM jobs WHERE file_path = ? AND status IN ('pending', 'running')"
  );
  const insert = db.prepare(
    `INSERT INTO jobs (id, file_path, status, max_dimension, quality, keep_original, force_jpeg)
     VALUES (?, ?, 'pending', ?, ?, ?, ?)`
  );

  let queued = 0;
  let skippedAlreadyQueued = 0;
  const ids: string[] = [];

  for (const photo of photos) {
    if (existsActive.get(photo.filePath)) {
      skippedAlreadyQueued++;
      continue;
    }
    const id = randomUUID();
    insert.run(
      id,
      photo.filePath,
      photo.maxDimension,
      photo.quality,
      photo.keepOriginal ? 1 : 0,
      photo.forceJpeg ? 1 : 0
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

export function cancelPendingJobs(ids: string[]): number {
  const cancel = db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'");
  let changed = 0;
  for (const id of ids) {
    changed += cancel.run(id).changes;
  }
  return changed;
}

export function deletePendingJobs(): number {
  return db.prepare("DELETE FROM jobs WHERE status = 'pending'").run().changes;
}

export function deleteDoneJobs(): number {
  return db.prepare("DELETE FROM jobs WHERE status = 'done'").run().changes;
}

export function deleteJobs(ids: string[]): number {
  const del = db.prepare("DELETE FROM jobs WHERE id = ? AND status NOT IN ('pending', 'running')");
  let changed = 0;
  for (const id of ids) {
    changed += del.run(id).changes;
  }
  return changed;
}
