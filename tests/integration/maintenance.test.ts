import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp } from "../helpers/testApp";

let tmpDir: string;
let filesDir: string;
let backups: typeof import("@/lib/backups");
let persistence: typeof import("@/lib/persistence");
let stats: typeof import("@/lib/stats");

const write = (rel: string, bytes: number) => {
  const full = path.join(filesDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
};
const exists = (rel: string) => fs.existsSync(path.join(filesDir, rel));

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-maintenance-test-");
  tmpDir = app.tmpDir;
  filesDir = app.photosDir;
  backups = await import("@/lib/backups");
  persistence = await import("@/lib/persistence");
  stats = await import("@/lib/stats");

  // Vidéos : sauvegarde normale, sauvegarde suffixée (collision), orpheline.
  write("Films/film.mkv", 100);
  write("Films/film.mkv.bkp", 400);
  write("Films/film_1.mkv.bkp", 300);
  write("Films/perdu.mkv.bkp", 200);
  // Photos : original classique, original converti en JPG, orphelin.
  write("Vacances/a.jpg", 10);
  write("Vacances/origin/a.jpg", 50);
  write("Vacances/b.jpg", 10);
  write("Vacances/origin/b.png", 60);
  write("Vacances/origin/c.jpg", 70);
  // Ni l'un ni l'autre : jamais listés ni supprimables.
  write("Vacances/notes.txt", 5);
  write("Films/bande-annonce.mp4.bkp", 5);
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("listBackups — sauvegardes de l'app et leur fichier optimisé", () => {
  it("trouve .mkv.bkp et originaux d'origin/, les plus lourds d'abord", () => {
    const entries = backups.listBackups();
    expect(entries.map((e) => [e.path, e.optimizedPath])).toEqual([
      ["Films/film.mkv.bkp", "Films/film.mkv"],
      ["Films/film_1.mkv.bkp", "Films/film.mkv"],
      ["Films/perdu.mkv.bkp", null],
      ["Vacances/origin/c.jpg", null],
      ["Vacances/origin/b.png", "Vacances/b.jpg"],
      ["Vacances/origin/a.jpg", "Vacances/a.jpg"],
    ]);
  });
});

describe("deleteBackups — tout est revérifié côté serveur", () => {
  it("refuse une sauvegarde sans fichier optimisé (seule copie) et tout fichier qui n'en est pas une", () => {
    const outcome = backups.deleteBackups([
      "Films/perdu.mkv.bkp",
      "Vacances/origin/c.jpg",
      "Films/film.mkv",
      "Vacances/notes.txt",
      "Films/bande-annonce.mp4.bkp",
      "../../etc/passwd",
    ]);
    expect(outcome.deleted).toBe(0);
    expect(outcome.refused.map((r) => r.path)).toHaveLength(6);
    expect(exists("Films/perdu.mkv.bkp")).toBe(true);
    expect(exists("Films/film.mkv")).toBe(true);
    expect(exists("Vacances/notes.txt")).toBe(true);
  });

  it("supprime les sauvegardes vérifiables, retire le dossier origin/ vidé, ne touche jamais au résultat", () => {
    const outcome = backups.deleteBackups(["Films/film.mkv.bkp", "Vacances/origin/a.jpg", "Vacances/origin/b.png"]);
    expect(outcome).toMatchObject({ deleted: 3, freedBytes: 510, refused: [] });
    expect(exists("Films/film.mkv")).toBe(true);
    expect(exists("Vacances/a.jpg")).toBe(true);
    // c.jpg (orphelin) reste : origin/ n'est pas vide, donc conservé.
    expect(exists("Vacances/origin")).toBe(true);

    fs.rmSync(path.join(filesDir, "Vacances/origin/c.jpg"));
    write("Vacances/c.jpg", 10);
    write("Vacances/origin/c.jpg", 70);
    expect(backups.deleteBackups(["Vacances/origin/c.jpg"]).deleted).toBe(1);
    expect(exists("Vacances/origin")).toBe(false);
  });
});

describe("checkDataPersistence — la base survivra-t-elle à une mise à jour ?", () => {
  // Lignes réelles de /proc/self/mountinfo relevées dans un conteneur.
  const line = (root: string, mountPoint: string) =>
    `1170 1159 259:2 ${root} ${mountPoint} rw,relatime - ext4 /dev/nvme0n1p2 rw`;
  const rootfs = "1159 1033 0:62 / / rw,relatime - overlay overlay rw";

  it("OK : dossier du NAS (bind mount) ou volume nommé sur /data", () => {
    const bind = [rootfs, line("/volume1/docker/file-optimizer/data", "/data")].join("\n");
    expect(persistence.checkDataPersistence(bind, "/data", true)).toEqual({ ok: true });
    const named = [rootfs, line("/var/lib/docker/volumes/file-optimizer_data/_data", "/data")].join("\n");
    expect(persistence.checkDataPersistence(named, "/data", true)).toEqual({ ok: true });
  });

  it("alerte : volume anonyme (montage mal placé, ex: sur /app/data au lieu de /data)", () => {
    const hex = "c52f2a5a352c31826092aecf92a35ce94aefa27714d4653cfa772179ef4e4496";
    const anonymous = [
      rootfs,
      line(`/var/lib/docker/volumes/${hex}/_data`, "/data"),
      line("/volume1/docker/file-optimizer/data", "/app/data"),
    ].join("\n");
    const result = persistence.checkDataPersistence(anonymous, "/data", true);
    expect(result.ok).toBe(false);
    // Synology : racine Docker sur /volume1/@docker.
    const synology = [rootfs, line(`/@docker/volumes/${hex}/_data`, "/data")].join("\n");
    expect(persistence.checkDataPersistence(synology, "/data", true).ok).toBe(false);
  });

  it("alerte : aucun volume (base dans la couche du conteneur) ; jamais hors Docker", () => {
    expect(persistence.checkDataPersistence(rootfs, "/data", true).ok).toBe(false);
    expect(persistence.checkDataPersistence(rootfs, "/data", false)).toEqual({ ok: true });
  });
});

describe("stats — bilan cumulé, indépendant de l'historique des jobs", () => {
  it("cumule par type, en ne comptant comme réduits que les fichiers plus petits", () => {
    const before = stats.getStats();
    stats.recordJobStats("video", 4000, 2000);
    stats.recordJobStats("video", 1000, 1000);
    stats.recordJobStats("image", 300, 100);
    const after = stats.getStats();
    expect(after.video.processed - before.video.processed).toBe(2);
    expect(after.video.optimized - before.video.optimized).toBe(1);
    expect(after.video.savedBytes - before.video.savedBytes).toBe(2000);
    expect(after.video.originalBytes - before.video.originalBytes).toBe(4000);
    expect(after.image.savedBytes - before.image.savedBytes).toBe(200);
  });
});
