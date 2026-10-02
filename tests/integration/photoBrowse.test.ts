import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp } from "../helpers/testApp";

let tmpDir: string;
let photosDir: string;
let InvalidPathError: typeof import("@/lib/photoBrowse").InvalidPathError;
let resolvePhotoPath: typeof import("@/lib/photoBrowse").resolvePhotoPath;
let listPhotoEntries: typeof import("@/lib/photoBrowse").listPhotoEntries;
let listPhotosRecursive: typeof import("@/lib/photoBrowse").listPhotosRecursive;

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-browse-test-");
  tmpDir = app.tmpDir;
  photosDir = app.photosDir;
  ({ InvalidPathError, resolvePhotoPath, listPhotoEntries, listPhotosRecursive } = await import(
    "@/lib/photoBrowse"
  ));

  fs.mkdirSync(path.join(photosDir, "vacances", "jour1"), { recursive: true });
  fs.mkdirSync(path.join(photosDir, "vacances", "origin"), { recursive: true });
  fs.mkdirSync(path.join(photosDir, "@eaDir"), { recursive: true });
  fs.writeFileSync(path.join(photosDir, "vacances", "photo1.jpg"), "a");
  fs.writeFileSync(path.join(photosDir, "vacances", "notes.txt"), "b");
  fs.writeFileSync(path.join(photosDir, "vacances", "jour1", "photo2.png"), "c");
  // Un original déjà préservé par un run précédent : ne doit jamais être
  // re-scanné comme une photo à optimiser.
  fs.writeFileSync(path.join(photosDir, "vacances", "origin", "photo1.jpg"), "d");
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("resolvePhotoPath — empêche toute sortie de FILES_DIR", () => {
  it("résout un chemin relatif normal", () => {
    expect(resolvePhotoPath("vacances")).toBe(path.join(photosDir, "vacances"));
  });

  it("refuse une tentative de traversée (../)", () => {
    expect(() => resolvePhotoPath("../../etc")).toThrow(InvalidPathError);
  });
});

describe("listPhotoEntries — liste un seul niveau, ignore origin/ et @eaDir", () => {
  it("liste les dossiers et images de 'vacances', pas le dossier origin/", () => {
    const entries = listPhotoEntries("vacances");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["jour1", "notes.txt", "photo1.jpg"]);
  });

  it("classe correctement les types (directory/image/other)", () => {
    const entries = listPhotoEntries("vacances");
    const photo1 = entries.find((e) => e.name === "photo1.jpg");
    const notes = entries.find((e) => e.name === "notes.txt");
    const jour1 = entries.find((e) => e.name === "jour1");
    expect(photo1?.type).toBe("image");
    expect(notes?.type).toBe("other");
    expect(jour1?.type).toBe("directory");
  });

  it("n'expose jamais le dossier de cache Synology @eaDir à la racine", () => {
    const entries = listPhotoEntries("");
    expect(entries.some((e) => e.name === "@eaDir")).toBe(false);
  });
});

describe("listPhotosRecursive — descend dans les sous-dossiers, ignore origin/", () => {
  it("trouve les photos de tous les sous-niveaux, pas l'original déjà préservé", () => {
    const files = listPhotosRecursive("vacances").sort();
    expect(files).toEqual(
      [
        path.join(photosDir, "vacances", "jour1", "photo2.png"),
        path.join(photosDir, "vacances", "photo1.jpg"),
      ].sort()
    );
  });
});
