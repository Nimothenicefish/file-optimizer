import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Prépare une instance d'app isolée pour un fichier de test : DATA_DIR et
// FILES_DIR temporaires (dossiers dédiés, jamais partagés entre fichiers de
// test grâce à pool: "forks" dans vitest.config.ts), puis démarre le worker
// en arrière-plan comme le fait normalement src/instrumentation.ts au
// démarrage réel. Les variables d'env doivent être positionnées AVANT le
// premier import de tout module qui touche DATA_DIR/FILES_DIR
// (src/lib/paths.ts les lit une seule fois, au chargement) — d'où l'import
// dynamique ici plutôt qu'un import statique en tête de fichier de test.
export async function setupTestApp(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(tmpDir, "data");
  const photosDir = path.join(tmpDir, "photos");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(photosDir, { recursive: true });

  process.env.DATA_DIR = dataDir;
  process.env.FILES_DIR = photosDir;
  process.env.AUTH_USER = "test-admin";
  process.env.AUTH_PASSWORD = "test-secret";

  const { db } = await import("@/lib/db");
  const { startWorker } = await import("@/lib/queue/worker");
  startWorker();

  return { tmpDir, dataDir, photosDir, db };
}

export function cleanupTestApp(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Sonde `check` à intervalle régulier jusqu'à ce qu'elle retourne true, ou
// lève une erreur après timeoutMs.
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 100, message = "condition non remplie" } = {}
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timeout après ${timeoutMs}ms — ${message}`);
}
