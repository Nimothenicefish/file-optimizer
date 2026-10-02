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
  forceJpeg?: boolean;
  onProgress?: (message: string) => void;
};

export type OptimizeImageResult = {
  originalSize: number;
  optimizedSize: number;
  // Chemin final du fichier (identique à filePath, sauf conversion forcée en
  // JPG d'une source dans un autre format : l'extension change alors).
  finalPath: string;
};

const JPEG_EXTS = new Set(["jpg", "jpeg"]);

// Chemin de sortie si le format change (conversion forcée en JPG) : même nom,
// nouvelle extension, en évitant toute collision avec un fichier déjà présent
// (ex: photo.png ET photo.jpg existaient déjà tous les deux).
function resolveOutputPath(filePath: string, targetExt: string): string {
  const sourceExt = path.extname(filePath).slice(1).toLowerCase();
  if (targetExt === sourceExt) return filePath;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  // turbopackIgnore : chemin dynamique sous FILES_DIR (volume monté au
  // runtime), jamais un fichier du projet — voir la même annotation dans
  // moveToOriginFolder ci-dessous pour le contexte complet.
  let target = path.join(/*turbopackIgnore: true*/ dir, `${base}.${targetExt}`);
  let counter = 1;
  while (fs.existsSync(/*turbopackIgnore: true*/ target)) {
    target = path.join(/*turbopackIgnore: true*/ dir, `${base}_${counter}.${targetExt}`);
    counter++;
  }
  return target;
}

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
// transparence d'un PNG ni changer l'extension/contenu d'un fichier) — sauf
// si forceJpeg est demandé explicitement : conversion en JPG garantissant
// dans certains cas un gain de place (compression à perte plus agressive
// qu'un PNG recompressé sans perte), au prix de la transparence éventuelle.
export async function optimizeImage(params: OptimizeImageParams): Promise<OptimizeImageResult> {
  const { filePath, maxDimension, quality, keepOriginal, forceJpeg = false, onProgress } = params;

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

  const sourceExt = path.extname(filePath).slice(1).toLowerCase();
  // Forcer en JPG n'a de sens que si la source n'est pas déjà un JPEG —
  // sinon on garde juste le ré-encodage normal (pas de renommage inutile
  // .jpeg -> .jpg).
  const targetExt = forceJpeg && !JPEG_EXTS.has(sourceExt) ? "jpg" : sourceExt;
  const convertingToJpeg = targetExt !== sourceExt;

  let output: Buffer;
  switch (targetExt) {
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
    default: {
      // jpg/jpeg (y compris une conversion forcée depuis un autre format).
      let pipeline = image;
      if (convertingToJpeg && metadata.hasAlpha) {
        // JPEG ne supporte pas la transparence : aplati sur fond blanc
        // plutôt que de laisser sharp aplatir sur noir par défaut (surprenant
        // pour une capture d'écran/un graphique à fond transparent).
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
        onProgress?.("transparence aplatie sur fond blanc (conversion forcée en JPG)");
      }
      output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
      break;
    }
  }

  // Un ré-encodage ne réduit pas TOUJOURS la taille (photo déjà bien
  // compressée par le téléphone/l'appareil, qualité demandée supérieure à
  // celle d'origine...) : si le résultat est plus gros ou égal, on garde le
  // fichier d'origine intact plutôt que de dégrader ce qu'on est censé
  // optimiser. Jamais de fichier "origin/" créé dans ce cas : rien n'a été
  // remplacé, il n'y a rien à sauvegarder.
  if (output.length >= originalSize) {
    onProgress?.(
      `déjà optimale (${originalSize} octets, le ré-encodage donnait ${output.length}) : fichier conservé tel quel`
    );
    return { originalSize, optimizedSize: originalSize, finalPath: filePath };
  }

  const optimizedSize = output.length;
  const outputPath = resolveOutputPath(filePath, targetExt);
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, output);

  if (keepOriginal) {
    moveToOriginFolder(filePath);
  }

  fs.renameSync(tmpPath, outputPath);

  if (!keepOriginal && outputPath !== filePath) {
    // Le format a changé (conversion forcée en JPG) : l'ancien fichier
    // (autre extension) doit disparaître, sinon il reste en double à côté
    // du nouveau.
    fs.unlinkSync(filePath);
  }

  return { originalSize, optimizedSize, finalPath: outputPath };
}
