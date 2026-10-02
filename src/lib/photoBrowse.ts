import fs from "node:fs";
import path from "node:path";
import { PHOTOS_DIR } from "@/lib/paths";
import { ORIGIN_FOLDER_NAME, isSynologyEaDir } from "@/lib/naming";

// Formats pris en charge : chacun est ré-encodé dans SON PROPRE format (pas
// de conversion vers un format universel) — voir src/lib/pipeline/
// optimizeImage.ts. Un format en dehors de cette liste n'est ni listé comme
// "image" ni sélectionnable/scannable.
export const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

export class InvalidPathError extends Error {}

// Résout un chemin relatif (fourni par le client) sous PHOTOS_DIR, en
// empêchant toute sortie du dossier (../, chemin absolu, etc).
export function resolvePhotoPath(relPath: string): string {
  const clean = (relPath || "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(PHOTOS_DIR, clean);
  if (resolved !== PHOTOS_DIR && !resolved.startsWith(PHOTOS_DIR + path.sep)) {
    throw new InvalidPathError("Chemin invalide");
  }
  return resolved;
}

// Inverse de resolvePhotoPath : chemin absolu -> relatif à PHOTOS_DIR,
// toujours avec des "/" (même sous Windows en dev), utilisable tel quel dans
// les appels API/URLs.
export function toPhotoRelPath(absPath: string): string {
  return path.relative(PHOTOS_DIR, absPath).split(path.sep).join("/");
}

export type BrowseEntry = {
  name: string;
  path: string; // relatif à PHOTOS_DIR
  type: "directory" | "image" | "other";
  size?: number;
};

// Liste le contenu d'un seul dossier (pas récursif) — pour la navigation pas
// à pas de l'UI. Le dossier "origin" (créé par cette app) n'est jamais
// listé : ce sont des originaux déjà mis de côté, pas des photos à parcourir.
export function listPhotoEntries(relPath: string): BrowseEntry[] {
  const dir = resolvePhotoPath(relPath);
  if (!fs.existsSync(dir)) return [];

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => !isSynologyEaDir(d.name) && d.name !== ORIGIN_FOLDER_NAME)
    .map((d): BrowseEntry => {
      const full = path.join(dir, d.name);
      const entryRelPath = toPhotoRelPath(full);
      if (d.isDirectory()) {
        return { name: d.name, path: entryRelPath, type: "directory" };
      }
      const ext = path.extname(d.name).slice(1).toLowerCase();
      const type = IMAGE_EXT.has(ext) ? "image" : "other";
      let size: number | undefined;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = undefined;
      }
      return { name: d.name, path: entryRelPath, type, size };
    });

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return entries;
}

// Liste récursivement tous les fichiers image sous relPath (sous-dossiers
// compris), chemins ABSOLUS — pour le scan en masse. Ignore les dossiers
// "origin" (déjà des originaux préservés par un passage précédent, jamais à
// ré-optimiser) et les caches Synology.
export function listPhotosRecursive(relPath: string): string[] {
  const root = resolvePhotoPath(relPath);
  const result: string[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isSynologyEaDir(entry.name) || entry.name === ORIGIN_FOLDER_NAME) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (IMAGE_EXT.has(ext)) result.push(full);
    }
  }

  walk(root);
  return result;
}
