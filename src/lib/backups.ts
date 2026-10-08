import fs from "node:fs";
import path from "node:path";
import { ORIGIN_FOLDER_NAME, isSynologyEaDir } from "@/lib/naming";
import { FILES_DIR } from "@/lib/paths";
import { IMAGE_EXT, resolvePhotoPath, toPhotoRelPath } from "@/lib/photoBrowse";
import { VIDEO_BACKUP_SUFFIX, VIDEO_EXT } from "@/lib/videoSettings";

// Sauvegardes laissées par l'app : sources vidéo conservées (film.mkv.bkp,
// voir optimizeVideo.ts) et originaux photo déplacés dans origin/ (voir
// optimizeImage.ts). Tant qu'elles existent, la place "gagnée" ne l'est pas
// vraiment : cette page permet de les supprimer une fois le résultat vérifié.
export type BackupEntry = {
  path: string; // relatif à FILES_DIR
  kind: "video" | "image";
  size: number;
  modifiedAt: number;
  // Fichier optimisé correspondant (null si introuvable : la sauvegarde est
  // alors la seule copie, sa suppression est refusée).
  optimizedPath: string | null;
  optimizedSize: number | null;
};

function fileSize(filePath: string): number | null {
  try {
    const stat = fs.statSync(/*turbopackIgnore: true*/ filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

// "nom_3.ext" -> "nom.ext" : suffixe ajouté par l'app quand une sauvegarde
// du même nom existait déjà (resolveBackupPath / moveToOriginFolder).
function withoutCollisionSuffix(fileName: string): string | null {
  const ext = path.extname(fileName);
  const match = /^(.*)_\d+$/.exec(path.basename(fileName, ext));
  return match ? `${match[1]}${ext}` : null;
}

function isVideoBackupName(name: string): boolean {
  if (!name.toLowerCase().endsWith(VIDEO_BACKUP_SUFFIX)) return false;
  const inner = name.slice(0, -VIDEO_BACKUP_SUFFIX.length);
  return VIDEO_EXT.has(path.extname(inner).slice(1).toLowerCase());
}

// Fichier optimisé d'une sauvegarde (chemin absolu), d'après les règles de
// nommage de l'app ; null si aucun candidat n'existe.
function findOptimized(backupPath: string): string | null {
  const dir = path.dirname(backupPath);
  const name = path.basename(backupPath);
  const candidates: string[] = [];

  if (isVideoBackupName(name)) {
    const inner = name.slice(0, -VIDEO_BACKUP_SUFFIX.length);
    candidates.push(inner);
    const stripped = withoutCollisionSuffix(inner);
    if (stripped) candidates.push(stripped);
    return candidates.map((c) => path.join(dir, c)).find((c) => fileSize(c) != null) ?? null;
  }

  // Original photo : <dossier>/origin/<nom> -> <dossier>/<nom>, ou en .jpg
  // si la conversion forcée en JPG était active.
  const parent = path.dirname(dir);
  const stripped = withoutCollisionSuffix(name) ?? name;
  for (const base of new Set([name, stripped])) {
    candidates.push(base, `${path.basename(base, path.extname(base))}.jpg`);
  }
  return candidates.map((c) => path.join(parent, c)).find((c) => fileSize(c) != null) ?? null;
}

function isBackupPath(absPath: string): boolean {
  const name = path.basename(absPath);
  if (isVideoBackupName(name)) return true;
  const ext = path.extname(name).slice(1).toLowerCase();
  return path.basename(path.dirname(absPath)) === ORIGIN_FOLDER_NAME && IMAGE_EXT.has(ext);
}

function toEntry(absPath: string): BackupEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/*turbopackIgnore: true*/ absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const optimized = findOptimized(absPath);
  return {
    path: toPhotoRelPath(absPath),
    kind: isVideoBackupName(path.basename(absPath)) ? "video" : "image",
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    optimizedPath: optimized ? toPhotoRelPath(optimized) : null,
    optimizedSize: optimized ? fileSize(optimized) : null,
  };
}

// Parcourt toute la bibliothèque (sous-dossiers compris, hors caches
// Synology), les plus lourdes en premier.
export function listBackups(): BackupEntry[] {
  const entries: BackupEntry[] = [];

  function walk(dir: string) {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (isSynologyEaDir(d.name)) continue;
      const full = path.join(/*turbopackIgnore: true*/ dir, d.name);
      if (d.isDirectory()) {
        if (d.name === ORIGIN_FOLDER_NAME) {
          for (const f of fs.readdirSync(/*turbopackIgnore: true*/ full)) {
            const filePath = path.join(/*turbopackIgnore: true*/ full, f);
            if (!isBackupPath(filePath)) continue;
            const entry = toEntry(filePath);
            if (entry) entries.push(entry);
          }
        } else {
          walk(full);
        }
      } else if (isVideoBackupName(d.name)) {
        const entry = toEntry(full);
        if (entry) entries.push(entry);
      }
    }
  }

  walk(FILES_DIR);
  return entries.sort((a, b) => b.size - a.size);
}

export type DeleteBackupsOutcome = {
  deleted: number;
  freedBytes: number;
  refused: Array<{ path: string; reason: string }>;
};

// Supprime des sauvegardes. Tout est revérifié côté serveur, quoi que
// demande le client : le chemin doit être une sauvegarde de l'app (jamais un
// fichier quelconque) et son fichier optimisé doit exister (sinon la
// sauvegarde est la seule copie restante). Un dossier origin/ vidé est
// supprimé aussi.
export function deleteBackups(relPaths: string[]): DeleteBackupsOutcome {
  const outcome: DeleteBackupsOutcome = { deleted: 0, freedBytes: 0, refused: [] };
  for (const relPath of relPaths) {
    let absPath: string;
    try {
      absPath = resolvePhotoPath(relPath);
    } catch {
      outcome.refused.push({ path: relPath, reason: "chemin invalide" });
      continue;
    }
    if (!isBackupPath(absPath)) {
      outcome.refused.push({ path: relPath, reason: "pas une sauvegarde de file-optimizer" });
      continue;
    }
    const size = fileSize(absPath);
    if (size == null) {
      outcome.refused.push({ path: relPath, reason: "introuvable" });
      continue;
    }
    if (!findOptimized(absPath)) {
      outcome.refused.push({ path: relPath, reason: "fichier optimisé introuvable : seule copie" });
      continue;
    }
    fs.unlinkSync(/*turbopackIgnore: true*/ absPath);
    outcome.deleted++;
    outcome.freedBytes += size;

    const dir = path.dirname(absPath);
    if (path.basename(dir) === ORIGIN_FOLDER_NAME && fs.readdirSync(/*turbopackIgnore: true*/ dir).length === 0) {
      fs.rmdirSync(/*turbopackIgnore: true*/ dir);
    }
  }
  return outcome;
}
