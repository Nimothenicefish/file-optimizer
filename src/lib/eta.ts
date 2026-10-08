// Estimations d'avancement et de temps restant, calculées côté serveur (son
// horloge est celle qui a horodaté started_at/finished_at — voir
// src/lib/db/index.ts). Volontairement approximatives : elles extrapolent la
// vitesse déjà mesurée, sans rien savoir du contenu à venir.

export type EtaJob = {
  kind: string;
  status: string;
  file_path: string;
  progress: number | null;
  original_size: number | null;
  started_at: number | null;
  finished_at: number | null;
  paused_at: number | null;
  paused_ms: number;
};

export type BatchEstimate = {
  done: number;
  total: number;
  percent: number;
  // null tant qu'aucune mesure ne permet d'estimer (ex: aucune photo du lot
  // encore traitée, début d'un encodage vidéo).
  remainingMs: number | null;
};

// En dessous, l'extrapolation d'un encodage vidéo est trop instable (démarrage
// d'ffmpeg, premières images) pour être affichée.
const MIN_VIDEO_PERCENT = 1;
const MIN_VIDEO_ELAPSED_MS = 20_000;


const isTerminal = (job: EtaJob) => job.status !== "pending" && job.status !== "running";

// Temps de traitement effectif d'un job (jusqu'à maintenant s'il est en
// cours), pauses déduites — une vidéo gelée une nuit entière ne doit pas
// faire croire à un encodage 10x plus lent.
export function activeDurationMs(job: EtaJob, now: number): number {
  if (job.started_at == null) return 0;
  const end = job.finished_at ?? now;
  const currentPause = job.paused_at != null ? end - job.paused_at : 0;
  return Math.max(0, end - job.started_at - job.paused_ms - currentPause);
}

// Temps restant de l'encodage vidéo en cours : x265 avance à une vitesse à
// peu près constante, le reste prendra donc ~ le temps écoulé au prorata.
// 0 une fois l'encodage à 100 % (vérification finale en cours, quelques
// minutes au plus — non estimée).
export function runningVideoRemainingMs(job: EtaJob, now: number): number | null {
  if (job.status !== "running" || job.kind !== "video" || job.started_at == null) return null;
  const percent = job.progress ?? 0;
  if (percent >= 100) return 0;
  const elapsed = activeDurationMs(job, now);
  if (percent < MIN_VIDEO_PERCENT || elapsed < MIN_VIDEO_ELAPSED_MS) return null;
  return (elapsed * (100 - percent)) / percent;
}

// Temps d'encodage effectif et octets source cumulés des vidéos réellement
// encodées (terminées) parmi jobs : base de la vitesse en ms par octet,
// réutilisée par l'analyse préalable d'un dossier (voir videoAnalysis.ts).
// "Réellement encodée" = encodage mené à 100 % : une vidéo laissée telle
// quelle (déjà en HEVC, déjà optimisée) n'a jamais d'avancement et, finie en
// quelques secondes, fausserait la vitesse.
export function measuredVideoSpeed(jobs: EtaJob[], now: number): { ms: number; bytes: number } {
  let ms = 0;
  let bytes = 0;
  for (const j of jobs) {
    if (j.kind !== "video" || j.status !== "done" || !j.original_size) continue;
    if ((j.progress ?? 0) < 100) continue;
    ms += activeDurationMs(j, now);
    bytes += j.original_size;
  }
  return { ms, bytes };
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Avancement et temps restant d'un lot (scan ou sélection) :
// - photos : durée moyenne des photos déjà traitées du lot x photos restantes ;
// - vidéos : vitesse mesurée en ms par octet source (vidéos déjà encodées du
//   lot + projection de celle en cours) x taille des vidéos restantes — tient
//   compte d'un film 3x plus lourd qu'un épisode, à défaut de mieux sans
//   analyser chaque fichier à l'avance.
// sizeOf : taille actuelle d'un fichier (null si introuvable), appelée
// seulement pour les vidéos non terminées.
export function estimateBatch(
  jobs: EtaJob[],
  now: number,
  sizeOf: (filePath: string) => number | null
): BatchEstimate {
  const total = jobs.length;
  const done = jobs.filter(isTerminal).length;
  const running = jobs.find((j) => j.status === "running");
  const pending = jobs.filter((j) => j.status === "pending");

  const duration = (j: EtaJob) => activeDurationMs(j, now);
  const finished = jobs.filter((j) => j.status === "done" && j.started_at != null);

  const imageAvgMs = average(finished.filter((j) => j.kind !== "video").map(duration));

  let { ms: videoMs, bytes: videoBytes } = measuredVideoSpeed(jobs, now);

  let remaining: number | null = 0;
  const add = (ms: number | null) => {
    remaining = remaining == null || ms == null ? null : remaining + ms;
  };

  if (running) {
    if (running.kind === "video") {
      const left = runningVideoRemainingMs(running, now);
      add(left);
      const size = sizeOf(running.file_path);
      if (left != null && left > 0 && size) {
        videoMs += duration(running) + left;
        videoBytes += size;
      }
    } else {
      add(imageAvgMs == null ? 0 : Math.max(0, imageAvgMs - duration(running)));
    }
  }

  const msPerVideoByte = videoBytes > 0 ? videoMs / videoBytes : null;
  for (const j of pending) {
    if (j.kind === "video") {
      const size = sizeOf(j.file_path);
      add(msPerVideoByte != null && size != null ? size * msPerVideoByte : null);
    } else {
      add(imageAvgMs);
    }
  }

  // Avancement en temps de travail quand le reste est estimable (plus
  // parlant qu'un nombre de fichiers quand un lot mêle photos et vidéos),
  // sinon en nombre de fichiers (job vidéo en cours compté au prorata).
  const spent = jobs.filter((j) => j.started_at != null).reduce((sum, j) => sum + duration(j), 0);
  let percent: number;
  if (remaining != null && spent + remaining > 0) {
    percent = (spent / (spent + remaining)) * 100;
  } else {
    const runningShare = running?.kind === "video" ? (running.progress ?? 0) / 100 : 0;
    percent = total > 0 ? ((done + runningShare) / total) * 100 : 0;
  }
  if (done === total) percent = 100;

  return { done, total, percent: Math.min(100, Math.max(0, percent)), remainingMs: remaining };
}
