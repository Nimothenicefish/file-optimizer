import { db } from "@/lib/db";

// Lu à chaque appel (pas mis en cache) — un changement fait depuis /jobs doit
// s'appliquer au prochain passage du worker (toutes les 1s), sans redémarrage.
export function isQueuePaused(): boolean {
  const row = db.prepare("SELECT paused FROM queue_settings WHERE id = 1").get() as {
    paused: number;
  };
  return row.paused === 1;
}

export function setQueuePaused(paused: boolean): void {
  db.prepare("UPDATE queue_settings SET paused = ? WHERE id = 1").run(paused ? 1 : 0);
}
