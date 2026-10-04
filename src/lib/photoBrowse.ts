import fs from "node:fs";
import path from "node:path";
import { FILES_DIR } from "@/lib/paths";
import { ORIGIN_FOLDER_NAME, isSynologyEaDir } from "@/lib/naming";
import type { JobKind } from "@/lib/queue/jobs";
import { VIDEO_EXT } from "@/lib/videoSettings";

// Formats pris en charge : chacun est ré-encodé dans SON PROPRE format (pas
// de conversion vers un format universel) — voir src/lib/pipeline/
// optimizeImage.ts. Un format en dehors de cette liste n'est ni listé comme
// "image" ni sélectionnable/scannable.
export const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

export class InvalidPathError extends Error {}

// Type de média d'un fichier d'après son extension (voir IMAGE_EXT et
// VIDEO_EXT), ou null s'il n'est pas pris en charge.
export function mediaKind(fileName: string): JobKind | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

const IMAGE_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

// Type MIME pour un fichier listé comme "image" (voir IMAGE_EXT) — utilisé
// pour servir son contenu brut (aperçu dans l'UI). Ne couvre que les formats
// pris en charge : jamais appelé pour un fichier "other".
export function imageContentType(fileName: string): string | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return IMAGE_CONTENT_TYPE[ext] ?? null;
}

// Résout un chemin relatif (fourni par le client) sous FILES_DIR, en
// empêchant toute sortie du dossier (../, chemin absolu, etc).
export function resolvePhotoPath(relPath: string): string {
  const clean = (relPath || "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(FILES_DIR, clean);
  if (resolved !== FILES_DIR && !resolved.startsWith(FILES_DIR + path.sep)) {
    throw new InvalidPathError("Chemin invalide");
  }
  return resolved;
}

// Inverse de resolvePhotoPath : chemin absolu -> relatif à FILES_DIR,
// toujours avec des "/" (même sous Windows en dev), utilisable tel quel dans
// les appels API/URLs.
export function toPhotoRelPath(absPath: string): string {
  return path.relative(FILES_DIR, absPath).split(path.sep).join("/");
}

export type BrowseEntry = {
  name: string;
  path: string; // relatif à FILES_DIR
  type: "directory" | "image" | "video" | "other";
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
      const type = mediaKind(d.name) ?? "other";
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

// Liste récursivement tous les fichiers d'un type de média (photos OU
// vidéos, jamais les deux : un scan de photos ne doit pas embarquer un
// encodage vidéo de plusieurs heures par surprise) sous relPath
// (sous-dossiers compris), chemins ABSOLUS — pour le scan en masse. Ignore
// les dossiers "origin" (déjà des originaux préservés par un passage
// précédent, jamais à ré-optimiser) et les caches Synology.
export function listMediaRecursive(relPath: string, kind: JobKind): string[] {
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
      if (mediaKind(entry.name) === kind) result.push(full);
    }
  }

  walk(root);
  return result;
}
