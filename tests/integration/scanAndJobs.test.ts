import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp, waitFor } from "../helpers/testApp";

let tmpDir: string;
let photosDir: string;
let db: typeof import("@/lib/db").db;
let scanRoute: typeof import("@/app/api/scan/route");
let jobsRoute: typeof import("@/app/api/jobs/route");
let deletePendingRoute: typeof import("@/app/api/jobs/delete-pending/route");
let cancelRoute: typeof import("@/app/api/jobs/cancel/route");
let queueSettingsRoute: typeof import("@/app/api/queue-settings/route");

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-scan-test-");
  tmpDir = app.tmpDir;
  photosDir = app.photosDir;
  db = app.db;
  scanRoute = await import("@/app/api/scan/route");
  jobsRoute = await import("@/app/api/jobs/route");
  deletePendingRoute = await import("@/app/api/jobs/delete-pending/route");
  cancelRoute = await import("@/app/api/jobs/cancel/route");
  queueSettingsRoute = await import("@/app/api/queue-settings/route");

  fs.mkdirSync(path.join(photosDir, "album", "sous-dossier"), { recursive: true });
  await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toFile(path.join(photosDir, "album", "photo1.jpg"));
  await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 4, g: 5, b: 6 } } })
    .png()
    .toFile(path.join(photosDir, "album", "sous-dossier", "photo2.png"));
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

function scanRequest(body: Record<string, unknown>) {
  return scanRoute.POST(
    new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/scan — scan récursif", () => {
  it("trouve les photos de tous les sous-dossiers et les met en file, avec les réglages fournis", async () => {
    const res = await scanRequest({ path: "album", maxDimension: 1234, quality: 77, keepOriginal: false });
    const data = await res.json();
    expect(data.found).toBe(2);
    expect(data.queued).toBe(2);
    expect(data.skippedAlreadyQueued).toBe(0);
    expect(data.ids).toHaveLength(2);

    const rows = db
      .prepare("SELECT max_dimension, quality, keep_original, force_jpeg FROM jobs ORDER BY created_at")
      .all() as Array<{ max_dimension: number; quality: number; keep_original: number; force_jpeg: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.max_dimension).toBe(1234);
      expect(row.quality).toBe(77);
      expect(row.keep_original).toBe(0);
      // forceJpeg non fourni dans la requête : doit rester désactivé par défaut.
      expect(row.force_jpeg).toBe(0);
    }
  });

  it("un second scan du même dossier ne recrée pas de doublons tant que les jobs sont actifs", async () => {
    const res = await scanRequest({ path: "album" });
    const data = await res.json();
    expect(data.found).toBe(2);
    expect(data.queued).toBe(0);
    expect(data.skippedAlreadyQueued).toBe(2);
  });

  it("refuse un chemin invalide (tentative de traversée)", async () => {
    const res = await scanRequest({ path: "../../etc" });
    expect(res.status).toBe(400);
  });

  it("propage forceJpeg: true jusqu'au job créé", async () => {
    fs.mkdirSync(path.join(photosDir, "album2"), { recursive: true });
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 7, g: 8, b: 9 } } })
      .png()
      .toFile(path.join(photosDir, "album2", "photo3.png"));

    const res = await scanRequest({ path: "album2", forceJpeg: true });
    const data = await res.json();
    expect(data.queued).toBe(1);

    const row = db
      .prepare("SELECT force_jpeg FROM jobs WHERE id = ?")
      .get(data.ids[0]) as { force_jpeg: number };
    expect(row.force_jpeg).toBe(1);
  });
});

describe("GET /api/jobs — recap par statut", () => {
  it("expose le total et les jobs créés par le scan", async () => {
    const res = await jobsRoute.GET(new Request("http://localhost/api/jobs?pageSize=100"));
    const data = await res.json();
    expect(data.total).toBeGreaterThanOrEqual(2);
    expect(data.statusCounts.pending + data.statusCounts.running + data.statusCounts.done).toBeGreaterThanOrEqual(2);
  });

  it("filtre par ids (suivi de batch) sans pagination ni filtre de statut", async () => {
    const all = db.prepare("SELECT id FROM jobs ORDER BY created_at LIMIT 2").all() as Array<{ id: string }>;
    const res = await jobsRoute.GET(
      new Request(`http://localhost/api/jobs?ids=${all.map((r) => r.id).join(",")}`)
    );
    const data = await res.json();
    expect(data.jobs).toHaveLength(2);
    expect(new Set(data.jobs.map((j: { id: string }) => j.id))).toEqual(new Set(all.map((r) => r.id)));
  });

  it("expose l'état de pause de la file (false par défaut)", async () => {
    const res = await jobsRoute.GET(new Request("http://localhost/api/jobs?pageSize=100"));
    const data = await res.json();
    expect(data.paused).toBe(false);
  });
});

describe("GET/PATCH /api/queue-settings — pause de la file", () => {
  it("renvoie paused=false par défaut, puis true après activation", async () => {
    const before = await (await queueSettingsRoute.GET()).json();
    expect(before.paused).toBe(false);

    const patchRes = await queueSettingsRoute.PATCH(
      new Request("http://localhost/api/queue-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      })
    );
    const patchData = await patchRes.json();
    expect(patchData.paused).toBe(true);

    const after = await (await queueSettingsRoute.GET()).json();
    expect(after.paused).toBe(true);

    // Remis à false pour ne pas bloquer le reste de la suite (worker partagé
    // par tout ce fichier de test).
    await queueSettingsRoute.PATCH(
      new Request("http://localhost/api/queue-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false }),
      })
    );
  });

  it("refuse un corps sans booléen paused", async () => {
    const res = await queueSettingsRoute.PATCH(
      new Request("http://localhost/api/queue-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: "yes" }),
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs/cancel puis /api/jobs/delete-pending", () => {
  it("annule un job pending puis le supprime", async () => {
    const pending = db.prepare("SELECT id FROM jobs WHERE status = 'pending' LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!pending) return; // déjà traité par le worker, rien à annuler ici

    const cancelRes = await cancelRoute.POST(
      new Request("http://localhost/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [pending.id] }),
      })
    );
    const cancelData = await cancelRes.json();
    expect(cancelData.cancelled).toBe(1);

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(pending.id) as {
      status: string;
    };
    expect(row.status).toBe("cancelled");
  });

  it("laisse le worker terminer tous les jobs restants", async () => {
    await waitFor(() => {
      const row = db
        .prepare("SELECT COUNT(*) as c FROM jobs WHERE status IN ('pending', 'running')")
        .get() as { c: number };
      return row.c === 0;
    });
  });

  it("supprime tous les jobs encore en attente (no-op ici, déjà tous traités/annulés)", async () => {
    const res = await deletePendingRoute.POST();
    const data = await res.json();
    expect(data.deleted).toBe(0);
  });
});
