import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp, waitFor } from "../helpers/testApp";

// Fichier à part : après requeueOnShutdown, le worker de ce process ne
// démarre plus aucun job (comme un vrai conteneur en cours d'arrêt).
let tmpDir: string;
let photosDir: string;
let db: typeof import("@/lib/db").db;
let requeueOnShutdown: typeof import("@/lib/queue/worker").requeueOnShutdown;
let enqueueFiles: typeof import("@/lib/queue/worker").enqueueFiles;

function ffmpegWriting(target: string): number {
  let count = 0;
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.startsWith("ffmpeg") && cmdline.includes(target)) count++;
    } catch {
      // process terminé entre-temps
    }
  }
  return count;
}

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-shutdown-test-");
  tmpDir = app.tmpDir;
  photosDir = app.photosDir;
  db = app.db;
  ({ requeueOnShutdown, enqueueFiles } = await import("@/lib/queue/worker"));
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("arrêt propre du conteneur pendant un encodage", () => {
  it("interrompt ffmpeg, supprime le fichier temporaire et remet le job en attente", async () => {
    const filePath = path.join(photosDir, "film.mkv");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=30",
      "-f", "lavfi", "-i", "sine=duration=30",
      "-c:v", "libx264", "-crf", "8", "-preset", "ultrafast", "-c:a", "aac",
      filePath,
    ]);
    const before = fs.readFileSync(filePath);
    const partPath = `${filePath}.part`;

    const { ids } = enqueueFiles([
      {
        filePath,
        kind: "video",
        maxDimension: 0,
        quality: 0,
        keepOriginal: false,
        forceJpeg: false,
        videoCrf: 22,
        videoPreset: "slow",
        videoProfile: "film",
      },
    ]);
    const row = () =>
      db.prepare("SELECT status, started_at, log FROM jobs WHERE id = ?").get(ids[0]) as {
        status: string;
        started_at: number | null;
        log: string;
      };

    await waitFor(() => fs.existsSync(partPath) && fs.statSync(partPath).size > 0, {
      timeoutMs: 30000,
    });
    expect(row().status).toBe("running");

    requeueOnShutdown();

    expect(row()).toMatchObject({ status: "pending", started_at: null });
    expect(row().log).toContain("remis en attente");
    expect(fs.existsSync(partPath)).toBe(false);
    await waitFor(() => ffmpegWriting(partPath) === 0, { timeoutMs: 5000 });
    // Le job interrompu ne se marque pas lui-même en erreur/annulé, et aucun
    // job ne redémarre pendant l'arrêt.
    await new Promise((r) => setTimeout(r, 2500));
    expect(row().status).toBe("pending");
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  }, 60000);
});
