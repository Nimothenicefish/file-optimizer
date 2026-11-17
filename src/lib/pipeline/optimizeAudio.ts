import fs from "node:fs";
import path from "node:path";
import {
  AUDIO_OUTPUT_EXT,
  type AudioQuality,
  AUDIO_QUALITY_LABEL,
  lameArgs,
  mp3SampleRate,
} from "@/lib/audioSettings";
import {
  DISK_RESERVE_BYTES,
  type Probe,
  type ProcessControl,
  partPathFor,
  probe,
  resolveBackupPath,
  runProcess,
} from "@/lib/pipeline/optimizeVideo";

export type OptimizeAudioParams = {
  filePath: string; // chemin absolu réel sur disque
  quality: AudioQuality;
  // Conserver la source à côté du MP3, renommée en <nom>.flac.bkp.
  keepSource: boolean;
  onProgress?: (message: string) => void;
} & ProcessControl;

export type OptimizeAudioResult = {
  originalSize: number;
  optimizedSize: number;
  finalPath: string;
};

const DURATION_TOLERANCE_S = 0.5;

// Tags principaux, ceux dont se servent les bibliothèques musicales (Emby,
// Plex...) pour classer les morceaux : vérifiés dans le MP3 produit.
const CHECKED_TAGS = ["title", "artist", "album", "album_artist", "date", "genre", "track", "disc"];

// Chemin du MP3 : même dossier, même nom (chanson.flac -> chanson.mp3).
export function audioOutputPath(filePath: string): string {
  const ext = path.extname(filePath);
  return path.join(
    /*turbopackIgnore: true*/ path.dirname(filePath),
    `${path.basename(filePath, ext)}.${AUDIO_OUTPUT_EXT}`
  );
}

// Un chanson.mp3 déjà présent à côté (autre version ?) n'est jamais écrasé.
export function audioOutputConflict(filePath: string): string | null {
  const outputPath = audioOutputPath(filePath);
  if (!fs.existsSync(/*turbopackIgnore: true*/ outputPath)) return null;
  return `${path.basename(outputPath)} existe déjà à côté : le MP3 ne peut pas prendre ce nom (renommer ou supprimer l'un des deux)`;
}

// Tags du fichier, clés en minuscules (le FLAC les garde comme elles ont été
// écrites : "ARTIST", "Artist"...).
function lowerTags(tags: Record<string, string> | undefined): Map<string, string> {
  return new Map(Object.entries(tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

// Numéro de piste/disque au format ID3 "3/12" : en FLAC, le total est
// souvent dans un tag à part (TRACKTOTAL/TOTALTRACKS), que le MP3 n'aurait
// sinon que dans un tag personnalisé ignoré des lecteurs.
function numberWithTotal(tags: Map<string, string>, key: "track" | "disc"): string | null {
  const number = tags.get(key);
  if (!number || number.includes("/")) return null;
  const total = tags.get(`${key}total`) ?? tags.get(`total${key}s`);
  return total ? `${number}/${total}` : null;
}

const isCover = (s: Probe["streams"][number]) => s.codec_type === "video";

// Écarts entre la source et le MP3 produit (vide si tout est conforme).
export function verifyAudioOutput(source: Probe, output: Probe, expectedTags: Map<string, string>): string[] {
  const problems: string[] = [];
  const audio = output.streams.filter((s) => s.codec_type === "audio");
  if (audio.length !== 1 || audio[0].codec_name !== "mp3") {
    problems.push(`piste audio MP3 attendue, trouvé : ${audio.map((s) => s.codec_name).join(", ") || "aucune"}`);
  }
  const srcCovers = source.streams.filter(isCover).length;
  const outCovers = output.streams.filter(isCover).length;
  if (outCovers !== srcCovers) problems.push(`pochette(s) : ${srcCovers} dans la source, ${outCovers} dans le MP3`);

  const srcDuration = Number(source.format.duration);
  const outDuration = Number(output.format.duration);
  if (
    Number.isFinite(srcDuration) &&
    (!Number.isFinite(outDuration) || Math.abs(srcDuration - outDuration) > DURATION_TOLERANCE_S)
  ) {
    problems.push(`durée : ${srcDuration.toFixed(2)} s dans la source, ${outDuration.toFixed(2)} s dans le MP3`);
  }

  const outTags = lowerTags(output.format.tags);
  for (const [key, value] of expectedTags) {
    if ((outTags.get(key) ?? "").trim() !== value.trim()) {
      problems.push(`tag ${key} : « ${value} » attendu, « ${outTags.get(key) ?? ""} » trouvé`);
    }
  }
  return problems;
}

// Convertit un FLAC en MP3 (LAME) à côté de la source : tags et pochette(s)
// recopiés (ID3v2.3, lu par tous les lecteurs et bibliothèques musicales),
// résultat vérifié AVANT de toucher à la source, puis source conservée en
// .flac.bkp ou supprimée. Une source hi-res est rééchantillonnée (le MP3
// s'arrête à 48 kHz), une source multicanal réduite en stéréo.
export async function optimizeAudio(params: OptimizeAudioParams): Promise<OptimizeAudioResult> {
  const { filePath, quality, keepSource, onProgress, signal, onProcess } = params;
  const ctl: ProcessControl = { signal, onProcess };
  const originalSize = fs.statSync(filePath).size;
  const outputPath = audioOutputPath(filePath);

  const conflict = audioOutputConflict(filePath);
  if (conflict) throw new Error(conflict);

  const source = await probe(filePath, ctl);
  const audio = source.streams.find((s) => s.codec_type === "audio") as
    | (Probe["streams"][number] & { sample_rate?: string; channels?: number })
    | undefined;
  if (!audio) throw new Error("Aucune piste audio dans ce fichier.");

  const { bavail, bsize } = fs.statfsSync(path.dirname(filePath));
  // Un MP3 est toujours bien plus petit que son FLAC : la taille de la
  // source est une borne haute confortable pour le fichier temporaire.
  if (bavail * bsize < originalSize + DISK_RESERVE_BYTES) {
    throw new Error(
      `Espace disque insuffisant : ${Math.round((bavail * bsize) / 1e6)} Mo libres (réserve de ${
        DISK_RESERVE_BYTES / 1024 ** 3
      } Go à garder).`
    );
  }

  const tags = lowerTags(source.format.tags);
  const extraArgs: string[] = [];
  const expectedTags = new Map<string, string>();
  for (const key of CHECKED_TAGS) {
    const value = tags.get(key);
    if (value) expectedTags.set(key, value);
  }
  for (const key of ["track", "disc"] as const) {
    const merged = numberWithTotal(tags, key);
    if (merged) {
      extraArgs.push("-metadata", `${key}=${merged}`);
      expectedTags.set(key, merged);
    }
  }
  const sampleRate = mp3SampleRate(Number(audio.sample_rate));
  if (sampleRate) {
    extraArgs.push("-ar", String(sampleRate));
    onProgress?.(`hi-res ${Number(audio.sample_rate) / 1000} kHz : rééchantillonné en ${sampleRate / 1000} kHz`);
  }
  if ((audio.channels ?? 2) > 2) {
    extraArgs.push("-ac", "2");
    onProgress?.(`${audio.channels} canaux : réduit en stéréo (le MP3 n'en a que 2)`);
  }
  const covers = source.streams.filter(isCover).length;
  onProgress?.(
    `conversion en MP3 ${AUDIO_QUALITY_LABEL[quality]} (${audio.codec_name ?? "?"} ${
      audio.sample_rate ? `${Number(audio.sample_rate) / 1000} kHz` : ""
    }, ${expectedTags.size} tag(s), ${covers} pochette(s))`
  );

  const partPath = partPathFor(filePath);
  try {
    await runProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        // Pochette(s) : images intégrées au FLAC, recopiées telles quelles.
        "-map",
        "0:v?",
        "-c:a",
        "libmp3lame",
        ...lameArgs(quality),
        "-c:v",
        "copy",
        "-map_metadata",
        "0",
        ...extraArgs,
        // ID3v2.3 plutôt que 2.4 (défaut) : le seul lu partout (Windows,
        // vieux autoradios, baladeurs).
        "-id3v2_version",
        "3",
        "-f",
        "mp3",
        partPath,
      ],
      () => {},
      ctl
    );

    const output = await probe(partPath, ctl);
    const problems = verifyAudioOutput(source, output, expectedTags);
    if (problems.length > 0) {
      throw new Error(`Résultat rejeté, source conservée intacte — ${problems.join(" ; ")}`);
    }
    onProgress?.("durée, tags et pochette vérifiés");
    const optimizedSize = fs.statSync(partPath).size;

    // Dernier point d'annulation : la suite (renommages) est synchrone.
    signal?.throwIfAborted();
    // Revérifié : un rename écraserait sans prévenir un MP3 apparu entre-temps.
    const lateConflict = audioOutputConflict(filePath);
    if (lateConflict) throw new Error(lateConflict);
    fs.renameSync(partPath, outputPath);
    if (keepSource) {
      const backupPath = resolveBackupPath(filePath);
      fs.renameSync(filePath, backupPath);
      onProgress?.(`source conservée : ${path.basename(backupPath)}`);
    } else {
      fs.unlinkSync(filePath);
    }
    return { originalSize, optimizedSize, finalPath: outputPath };
  } finally {
    if (fs.existsSync(/*turbopackIgnore: true*/ partPath)) fs.unlinkSync(partPath);
  }
}
