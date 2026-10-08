import fs from "node:fs";
import { db } from "@/lib/db";
import { type EtaJob, measuredVideoSpeed } from "@/lib/eta";
import { listMediaRecursive, toPhotoRelPath } from "@/lib/photoBrowse";
import { planVideo, probe } from "@/lib/pipeline/optimizeVideo";
import { hasActiveJob } from "@/lib/queue/jobs";
import type { SizeProfile, VideoProfile } from "@/lib/videoSettings";

export type AnalysisItem = {
  path: string; // relatif à FILES_DIR
  size: number;
  durationS: number | null;
  sizeProfile: SizeProfile | null;
  // encode : sera ré-encodée ; skip : laissée telle quelle ; queued : déjà en
  // file ; error : illisible (sera en erreur si lancée).
  action: "encode" | "skip" | "queued" | "error";
  reason: string | null;
  // Taille maximale visée si encodée (le résultat est souvent plus petit).
  targetSize: number | null;
};

export type AnalysisResult = {
  items: AnalysisItem[];
  toEncode: number;
  // Taille actuelle des vidéos à encoder, et place libérée AU MINIMUM (le
  // plafond de taille est un maximum : le CRF donne souvent moins).
  encodeBytes: number;
  minSavedBytes: number;
  // null sans vidéo déjà encodée par cette app pour mesurer la vitesse.
  estimatedMs: number | null;
};

// Analyse un dossier (récursif) AVANT de lancer quoi que ce soit : pour
// chaque MKV, lit ses métadonnées (ffprobe, sans décoder) et applique
// exactement la décision de l'encodage (voir planVideo). Fichiers lus un
// par un, en priorité minimale, comme l'encodage lui-même.
export async function analyzeVideos(relPath: string, profile: VideoProfile): Promise<AnalysisResult> {
  const items: AnalysisItem[] = [];
  for (const filePath of listMediaRecursive(relPath, "video")) {
    const size = fs.statSync(filePath).size;
    const base = { path: toPhotoRelPath(filePath), size };
    if (hasActiveJob(filePath)) {
      items.push({ ...base, durationS: null, sizeProfile: null, action: "queued", reason: null, targetSize: null });
      continue;
    }
    try {
      const plan = planVideo(await probe(filePath), size, profile);
      items.push({
        ...base,
        durationS: plan.durationS,
        sizeProfile: plan.sizeProfile,
        action: plan.action,
        reason: plan.action === "skip" ? plan.reason : plan.note,
        targetSize: plan.action === "encode" ? plan.targetSize : null,
      });
    } catch (err) {
      items.push({
        ...base,
        durationS: null,
        sizeProfile: null,
        action: "error",
        reason: err instanceof Error ? err.message : String(err),
        targetSize: null,
      });
    }
  }

  const encoded = items.filter((i) => i.action === "encode");
  const encodeBytes = encoded.reduce((sum, i) => sum + i.size, 0);
  const maxResultBytes = encoded.reduce((sum, i) => sum + (i.targetSize ?? i.size), 0);

  // Vitesse mesurée sur l'historique des encodages de cette app (même NAS,
  // mêmes limites) : bien plus réaliste qu'une valeur théorique.
  const history = db
    .prepare("SELECT * FROM jobs WHERE kind = 'video' AND status = 'done'")
    .all() as EtaJob[];
  const speed = measuredVideoSpeed(history, Date.now());
  const estimatedMs = speed.bytes > 0 && encoded.length > 0 ? (encodeBytes * speed.ms) / speed.bytes : null;

  return {
    items,
    toEncode: encoded.length,
    encodeBytes,
    minSavedBytes: Math.max(0, encodeBytes - maxResultBytes),
    estimatedMs: encoded.length === 0 ? 0 : estimatedMs,
  };
}
