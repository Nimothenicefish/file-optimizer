import { db } from "@/lib/db";
import type { JobKind } from "@/lib/queue/jobs";

export type KindStats = {
  processed: number; // jobs terminés (y compris laissés tels quels)
  optimized: number; // dont réellement réduits
  originalBytes: number; // taille d'origine des fichiers réduits
  savedBytes: number;
};

export type Stats = Record<JobKind, KindStats>;

// Comptabilise un job terminé dans le bilan cumulé (voir la table stats).
export function recordJobStats(kind: JobKind, originalSize: number, optimizedSize: number) {
  const reduced = optimizedSize < originalSize;
  db.prepare(
    `INSERT INTO stats (kind, processed, optimized, original_bytes, saved_bytes)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       processed = processed + 1,
       optimized = optimized + excluded.optimized,
       original_bytes = original_bytes + excluded.original_bytes,
       saved_bytes = saved_bytes + excluded.saved_bytes`
  ).run(kind, reduced ? 1 : 0, reduced ? originalSize : 0, reduced ? originalSize - optimizedSize : 0);
}

export function getStats(): Stats {
  const empty: KindStats = { processed: 0, optimized: 0, originalBytes: 0, savedBytes: 0 };
  const stats: Stats = { image: { ...empty }, video: { ...empty } };
  const rows = db.prepare("SELECT * FROM stats").all() as Array<{
    kind: string;
    processed: number;
    optimized: number;
    original_bytes: number;
    saved_bytes: number;
  }>;
  for (const row of rows) {
    if (row.kind !== "image" && row.kind !== "video") continue;
    stats[row.kind] = {
      processed: row.processed,
      optimized: row.optimized,
      originalBytes: row.original_bytes,
      savedBytes: row.saved_bytes,
    };
  }
  return stats;
}
