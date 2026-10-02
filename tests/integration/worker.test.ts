import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp, waitFor } from "../helpers/testApp";

let tmpDir: string;
let photosDir: string;
let db: typeof import("@/lib/db").db;
let recoverInterruptedJobs: typeof import("@/lib/queue/worker").recoverInterruptedJobs;

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-worker-test-");
  tmpDir = app.tmpDir;
  photosDir = app.photosDir;
  db = app.db;
  ({ recoverInterruptedJobs } = await import("@/lib/queue/worker"));
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("worker — traite un job 'pending' et le marque 'done'", () => {
  it("optimise réellement le fichier et renseigne original_size/optimized_size", async () => {
    const filePath = path.join(photosDir, "photo.jpg");
    await sharp({ create: { width: 6000, height: 3000, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg({ quality: 95 })
      .toFile(filePath);

    const jobId = randomUUID();
    db.prepare(
      `INSERT INTO jobs (id, file_path, status, max_dimension, quality, keep_original)
       VALUES (?, ?, 'pending', 2000, 85, 1)`
    ).run(jobId, filePath);

    await waitFor(() => {
      const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
        | { status: string }
        | undefined;
      return row?.status === "done";
    });

    const job = db
      .prepare("SELECT original_size, optimized_size FROM jobs WHERE id = ?")
      .get(jobId) as { original_size: number; optimized_size: number };
    expect(job.original_size).toBeGreaterThan(0);
    expect(job.optimized_size).toBeGreaterThan(0);

    expect(fs.existsSync(path.join(photosDir, "origin", "photo.jpg"))).toBe(true);
  });

  it("marque un job en erreur si le fichier n'existe plus", async () => {
    const jobId = randomUUID();
    db.prepare(
      `INSERT INTO jobs (id, file_path, status, max_dimension, quality, keep_original)
       VALUES (?, ?, 'pending', 2000, 85, 1)`
    ).run(jobId, path.join(photosDir, "introuvable.jpg"));

    await waitFor(() => {
      const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
        | { status: string }
        | undefined;
      return row?.status === "error";
    });

    const job = db.prepare("SELECT error FROM jobs WHERE id = ?").get(jobId) as {
      error: string;
    };
    expect(job.error).toContain("introuvable");
  });
});

describe("recoverInterruptedJobs — jobs 'running' orphelins après un arrêt du conteneur", () => {
  it("marque en erreur un job resté 'running', au lieu de le laisser bloqué pour toujours", () => {
    const jobId = randomUUID();
    db.prepare(
      `INSERT INTO jobs (id, file_path, status, max_dimension, quality, keep_original)
       VALUES (?, ?, 'running', 2000, 85, 1)`
    ).run(jobId, path.join(photosDir, "stuck.jpg"));

    recoverInterruptedJobs();

    const job = db.prepare("SELECT status, log FROM jobs WHERE id = ?").get(jobId) as {
      status: string;
      log: string;
    };
    expect(job.status).toBe("error");
    expect(job.log).toContain("redémarrage du conteneur");
  });
});
