import { DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY } from "@/lib/imageLimits";
import type { EnqueueParams, JobKind } from "@/lib/queue/jobs";
import {
  DEFAULT_VIDEO_CRF,
  DEFAULT_VIDEO_PRESET,
  DEFAULT_VIDEO_PROFILE,
  isVideoPreset,
  isVideoProfile,
} from "@/lib/videoSettings";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type OptimizeSettings = Omit<EnqueueParams, "filePath" | "kind" | "keepOriginal"> & {
  keepOriginal: boolean; // photos : origin/ (activé par défaut)
  keepVideoSource: boolean; // vidéos : .mkv.bkp (désactivé par défaut)
};

// Réglages d'optimisation envoyés par l'UI (scan ou sélection manuelle),
// bornés et complétés par les valeurs par défaut — jamais utilisés tels
// quels depuis le corps de la requête.
export function parseOptimizeSettings(body: Record<string, unknown> | null): OptimizeSettings {
  return {
    maxDimension: clampInt(body?.maxDimension, DEFAULT_MAX_DIMENSION, 100, 20000),
    quality: clampInt(body?.quality, DEFAULT_QUALITY, 1, 100),
    keepOriginal: body?.keepOriginal !== false,
    forceJpeg: body?.forceJpeg === true,
    videoCrf: clampInt(body?.videoCrf, DEFAULT_VIDEO_CRF, 0, 51),
    videoPreset: isVideoPreset(body?.videoPreset) ? body.videoPreset : DEFAULT_VIDEO_PRESET,
    videoProfile: isVideoProfile(body?.videoProfile) ? body.videoProfile : DEFAULT_VIDEO_PROFILE,
    keepVideoSource: body?.keepVideoSource === true,
  };
}

export function toEnqueueParams(filePath: string, kind: JobKind, settings: OptimizeSettings): EnqueueParams {
  const { keepVideoSource, ...rest } = settings;
  return {
    ...rest,
    filePath,
    kind,
    keepOriginal: kind === "video" ? keepVideoSource : settings.keepOriginal,
  };
}
