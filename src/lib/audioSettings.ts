// Mode "Musique" : conversion des FLAC en MP3 (voir
// src/lib/pipeline/optimizeAudio.ts). Contrairement aux photos et vidéos, le
// format change toujours (chanson.flac -> chanson.mp3) : c'est une
// conversion avec perte, voulue, pas une simple recompression.
export const AUDIO_FORMATS = ["flac"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export const AUDIO_EXT: ReadonlySet<string> = new Set(AUDIO_FORMATS);
export const AUDIO_OUTPUT_EXT = "mp3";

// Qualité MP3 (encodeur LAME) : VBR = débit variable, le plus efficace à
// qualité égale ; CBR 320 = débit fixe maximal du format.
export const AUDIO_QUALITIES = ["v0", "320", "v2"] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];
export const DEFAULT_AUDIO_QUALITY: AudioQuality = "v0";

export const AUDIO_QUALITY_LABEL: Record<AudioQuality, string> = {
  v0: "VBR V0 (~245 kb/s, recommandé)",
  "320": "CBR 320 kb/s (maximum)",
  v2: "VBR V2 (~190 kb/s, plus léger)",
};

export function isAudioQuality(value: unknown): value is AudioQuality {
  return typeof value === "string" && (AUDIO_QUALITIES as readonly string[]).includes(value);
}

// Options de l'encodeur libmp3lame pour une qualité.
export function lameArgs(quality: AudioQuality): string[] {
  if (quality === "320") return ["-b:a", "320k"];
  return ["-q:a", quality === "v0" ? "0" : "2"];
}

// Le MP3 ne monte pas au-delà de 48 kHz : une source hi-res (88,2/96/192 kHz)
// est rééchantillonnée vers la fréquence "de la même famille" (44,1 kHz pour
// un multiple de 44,1, sinon 48), sans effet audible sur un MP3.
export function mp3SampleRate(sourceRate: number): number | null {
  if (!Number.isFinite(sourceRate) || sourceRate <= 48000) return null;
  return sourceRate % 44100 === 0 ? 44100 : 48000;
}

// Extension ajoutée à la source conservée (chanson.flac -> chanson.flac.bkp,
// à côté du MP3) : hors AUDIO_EXT, jamais reprise par un scan ultérieur.
export const AUDIO_BACKUP_SUFFIX = ".bkp";
