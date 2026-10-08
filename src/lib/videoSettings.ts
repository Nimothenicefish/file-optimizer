// Formats vidéo pris en charge par le mode "Vidéos" (ré-encodage x265, voir
// src/lib/pipeline/optimizeVideo.ts). Volontairement limité au MKV : c'est
// le seul conteneur dont on garantit la conservation de TOUTES les pistes
// (audio multiples, sous-titres de tout type, polices ASS en pièces jointes,
// chapitres) telles quelles.
export const VIDEO_EXT = new Set(["mkv"]);

// Facteur de qualité constant x265 (0 = sans perte, 51 = le pire). 22 :
// visuellement quasi transparent sur un film 1080p, tout en divisant
// typiquement la taille d'un H.264 par ~2. Éditable par job dans l'UI.
export const DEFAULT_VIDEO_CRF = 22;

// Effet attendu d'une valeur de CRF x265, du meilleur au moins bon — pour
// l'aide de l'UI. Repère : +6 de CRF ≈ fichier ~2x plus petit (et -6 ≈ ~2x
// plus gros), à vidéo égale. Le plafond de taille (voir videoTargetSize)
// s'applique toujours en plus : un CRF bas ne fait jamais dépasser la cible.
export type CrfLevel = { max: number; label: string; detail: string };

export const CRF_LEVELS: CrfLevel[] = [
  {
    max: 17,
    label: "Quasi sans perte",
    detail: "indiscernable de la source, mais fichier gros : peu ou pas de place gagnée",
  },
  {
    max: 20,
    label: "Excellente",
    detail: "pour les films auxquels tu tiens le plus ; gain de place modéré",
  },
  {
    max: 24,
    label: "Très bonne (recommandé)",
    detail: "différence invisible en lecture normale, bon gain de place",
  },
  {
    max: 28,
    label: "Bonne",
    detail: "léger flou possible sur les détails fins et les scènes sombres ; fichier nettement plus petit",
  },
  {
    max: 51,
    label: "Moyenne à faible",
    detail: "défauts visibles (blocs, aplats) ; à réserver aux vidéos sans importance",
  },
];

export function describeCrf(crf: number): CrfLevel {
  return CRF_LEVELS.find((level) => crf <= level.max) ?? CRF_LEVELS[CRF_LEVELS.length - 1];
}

// Compromis vitesse d'encodage / taux de compression x265. Plus lent =
// fichier plus petit à qualité égale, mais un film peut prendre des heures
// sur un NAS (CPU faible, cœur unique épinglé — voir docker-compose.yml).
export const VIDEO_PRESETS = ["faster", "fast", "medium", "slow"] as const;
export type VideoPreset = (typeof VIDEO_PRESETS)[number];
export const DEFAULT_VIDEO_PRESET: VideoPreset = "medium";

export function isVideoPreset(value: unknown): value is VideoPreset {
  return typeof value === "string" && (VIDEO_PRESETS as readonly string[]).includes(value);
}

// Taille cible MAXIMALE du résultat, en fraction de la source (ex: 4 Go ->
// 2,8 Go au plus). Le CRF décide de la qualité ; ce plafond n'intervient que
// si le CRF seul produirait un fichier plus gros (débit vidéo maximal borné,
// voir computeVideoMaxrate) — en dessous, tant mieux.
export const VIDEO_TARGET_RATIO = 0.7;

// Profil de taille cible : "film" = VIDEO_TARGET_RATIO de la source ;
// "series" = en plus, plafond absolu proportionnel à la durée de l'épisode
// (un épisode n'a pas besoin du débit d'un film pour rester propre — anime
// et sitcoms se compressent particulièrement bien en x265) ; "auto" =
// l'un ou l'autre d'après la durée (voir resolveSizeProfile), pour scanner
// un dossier mixte sans se tromper de type.
export const VIDEO_PROFILES = ["auto", "film", "series"] as const;
export type VideoProfile = (typeof VIDEO_PROFILES)[number];
export type SizeProfile = Exclude<VideoProfile, "auto">;
export const DEFAULT_VIDEO_PROFILE: VideoProfile = "auto";

export function isVideoProfile(value: unknown): value is VideoProfile {
  return typeof value === "string" && (VIDEO_PROFILES as readonly string[]).includes(value);
}

// "auto" : en dessous, un épisode de série (sitcom ~20 min, série ~45-60
// min) ; au-dessus, un film (rarement moins de 75 min).
export const AUTO_SERIES_MAX_DURATION_S = 70 * 60;

export function resolveSizeProfile(profile: VideoProfile, durationS: number): SizeProfile {
  if (profile !== "auto") return profile;
  return durationS < AUTO_SERIES_MAX_DURATION_S ? "series" : "film";
}

// Plafond "series" : base + par minute — ~440 Mo pour 20 min (sitcom,
// anime), ~800 Mo pour 50 min.
const MB = 1024 * 1024;
export const SERIES_BASE_BYTES = 200 * MB;
export const SERIES_BYTES_PER_MINUTE = 12 * MB;

// Taille maximale visée pour le résultat (octets) — jamais plus de
// VIDEO_TARGET_RATIO de la source, quel que soit le profil.
export function videoTargetSize(sourceSize: number, durationS: number, profile: SizeProfile): number {
  const ratioCap = sourceSize * VIDEO_TARGET_RATIO;
  if (profile === "film") return ratioCap;
  return Math.min(ratioCap, seriesSizeCap(durationS));
}

function seriesSizeCap(durationS: number): number {
  return SERIES_BASE_BYTES + (SERIES_BYTES_PER_MINUTE * durationS) / 60;
}

// Film déjà "compact" : ~22 Mo par minute (~3 Mbit/s en moyenne, audio
// compris) — l'ordre de grandeur d'un film 1080p déjà bien encodé en x265.
export const FILM_COMPACT_BYTES_PER_MINUTE = 22 * MB;

// Taille en dessous de laquelle une vidéo DÉJÀ dans un codec efficace (voir
// VIDEO_SKIP_CODECS) est laissée telle quelle : la ré-encoder ne ferait que
// perdre en qualité pour un gain faible. Au-dessus (ex: épisode HEVC de
// 1,7 Go pour 45 min, copie 4K de Blu-ray), elle est ré-encodée comme une
// autre — le gain vaut alors la légère perte d'un second encodage.
export function compactSizeLimit(durationS: number, profile: SizeProfile): number {
  if (profile === "series") return seriesSizeCap(durationS);
  return (FILM_COMPACT_BYTES_PER_MINUTE * durationS) / 60;
}

// Codecs vidéo déjà au moins aussi efficaces que x265 : un fichier dont
// toutes les pistes vidéo sont dans un de ces codecs n'est ré-encodé que
// s'il est encore lourd pour son type (voir compactSizeLimit).
export const VIDEO_SKIP_CODECS = new Set(["hevc", "av1", "vp9"]);

// Tag MKV global posé sur chaque fichier produit par cette app : un fichier
// qui le porte n'est jamais ré-encodé (sans lui, un résultat encore au-dessus
// du seuil "compact" serait re-compressé à chaque nouveau scan).
export const VIDEO_OPTIMIZED_TAG = "FILE_OPTIMIZER";

// Extension ajoutée à la source quand l'utilisateur choisit de la conserver
// (film.mkv -> film.mkv.bkp, à côté du résultat). Hors VIDEO_EXT : jamais
// listée comme vidéo, donc jamais ré-encodée par un scan ultérieur.
export const VIDEO_BACKUP_SUFFIX = ".bkp";

// Fichier temporaire d'encodage (film.mkv.part), dans le même dossier que la
// source (renommage atomique à la fin, même système de fichiers). Lui aussi
// hors VIDEO_EXT : jamais pris pour une vidéo à optimiser pendant un encodage.
export const VIDEO_PART_SUFFIX = ".part";
