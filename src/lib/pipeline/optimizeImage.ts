import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { MAX_INPUT_PIXELS } from "@/lib/imageLimits";
import { ORIGIN_FOLDER_NAME } from "@/lib/naming";

export type OptimizeImageParams = {
  filePath: string; // chemin absolu réel sur disque
  maxDimension: number;
  quality: number;
  keepOriginal: boolean;
  onProgress?: (message: string) => void;
};

export type OptimizeImageResult = {
  originalSize: number;
  optimizedSize: number;
};

// Déplace le fichier source vers <dossier>/origin/<nom>, en évitant toute
// collision avec un original déjà préservé lors d'un run précédent (ajoute un
// suffixe numérique) — ne doit jamais écraser un original déjà mis de côté.
function moveToOriginFolder(filePath: string): void {
  const dir = path.dirname(filePath);
  const originDir = path.join(dir, ORIGIN_FOLDER_NAME);
  fs.mkdirSync(originDir, { recursive: true });

  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let target = path.join(originDir, path.basename(filePath));
  let counter = 1;
  // turbopackIgnore : "target" est une photo dans FILES_DIR (volume monté au
  // runtime), jamais un fichier du projet — sans cette annotation, l'analyse
  // statique de Turbopack trace (et embarque) tout le projet dans la sortie
  // standalone à cause de ce chemin dynamique.
  while (fs.existsSync(/*turbopackIgnore: true*/ target)) {
    target = path.join(originDir, `${base}_${counter}${ext}`);
    counter++;
  }
  fs.renameSync(filePath, target);
}

// Optimise une photo en place : redimensionne (si besoin) pendant le
// décodage (shrink-on-load, borne la mémoire quelle que soit la taille
// source — voir src/lib/imageLimits.ts) et ré-encode dans SON PROPRE format
// (jamais de conversion vers un format universel, pour ne jamais perdre la
// transparence d'un PNG ni changer l'extension/contenu d'un fichier).
export async function optimizeImage(params: OptimizeImageParams): Promise<OptimizeImageResult> {
  const { filePath, maxDimension, quality, keepOriginal, onProgress } = params;

  const originalBuffer = fs.readFileSync(filePath);
  const originalSize = originalBuffer.length;

  const image = sharp(originalBuffer, {
    // Par défaut sharp fait échouer le décodage sur le moindre avertissement
    // ("warning", le plus sensible) — trop strict pour des photos légèrement
    // imparfaites mais lisibles. Tolère jusqu'au niveau "error" inclus : une
    // vraie corruption fatale échoue toujours.
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  });

  const metadata = await image.metadata();
  if ((metadata.width ?? 0) > maxDimension || (metadata.height ?? 0) > maxDimension) {
    // Demandé AVANT toBuffer() : fait partie du même pipeline sharp que le
    // décodage lui-même (shrink-on-load).
    image.resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    });
    onProgress?.(
      `redimensionnée (${metadata.width}x${metadata.height} dépassait ${maxDimension}px)`
    );
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  let output: Buffer;
  switch (ext) {
    case "png":
      // Pas de notion de "qualité" standard pour un PNG (sans palette) :
      // compressionLevel au maximum applique une optimisation lossless
      // (équivalent pngcrush/optipng), le paramètre "quality" de l'appelant
      // ne s'applique qu'aux formats avec compression à perte.
      output = await image.png({ compressionLevel: 9 }).toBuffer();
      break;
    case "webp":
      output = await image.webp({ quality }).toBuffer();
      break;
    case "avif":
      output = await image.avif({ quality }).toBuffer();
      break;
    default:
      // jpg/jpeg
      output = await image.jpeg({ quality, mozjpeg: true }).toBuffer();
      break;
  }

  const optimizedSize = output.length;
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, output);

  if (keepOriginal) {
    moveToOriginFolder(filePath);
  }

  fs.renameSync(tmpPath, filePath);

  return { originalSize, optimizedSize };
}
