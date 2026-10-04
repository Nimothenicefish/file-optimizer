import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  VIDEO_BACKUP_SUFFIX,
  VIDEO_PART_SUFFIX,
  VIDEO_SKIP_CODECS,
  type VideoProfile,
  videoTargetSize,
} from "@/lib/videoSettings";

export type OptimizeVideoParams = {
  filePath: string; // chemin absolu réel sur disque
  crf: number;
  preset: string;
  // Plafond de taille du résultat (voir videoTargetSize).
  profile: VideoProfile;
  // Conserver la source à côté du résultat, renommée en <nom>.mkv.bkp.
  keepSource: boolean;
  onProgress?: (message: string) => void;
  // Avancement de l'encodage, en pourcentage (0-100).
  onPercent?: (percent: number) => void;
  // Annulation : arrête ffmpeg/ffprobe en cours ; la source n'est jamais
  // touchée (remplacée seulement à la toute fin, après le dernier contrôle).
  signal?: AbortSignal;
};

export type OptimizeVideoResult = {
  originalSize: number;
  optimizedSize: number;
  finalPath: string;
};

type ProbeStream = {
  index: number;
  codec_type: string;
  codec_name?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
};

export type Probe = {
  streams: ProbeStream[];
  format: { duration?: string; start_time?: string };
};

export type PacketStats = Map<number, { count: number; firstPts: number | null; lastPts: number | null }>;

// Débit vidéo maximal en dessous duquel on ne descend jamais, même si le
// budget calculé est plus bas (pistes audio très lourdes type TrueHD/DTS-HD) :
// en dessous, l'image se dégraderait franchement. Le fichier peut alors
// dépasser la taille cible — signalé dans le log, pas une erreur.
const MIN_VIDEO_MAXRATE_BPS = 500_000;

// Débit supposé d'une piste audio dont le conteneur n'indique pas le débit
// (ni bit_rate, ni tag BPS écrit par mkvmerge) — valeur haute (AC3 5.1 /
// DTS core) pour ne jamais sous-estimer la place prise par l'audio copié.
const UNKNOWN_AUDIO_BPS = 640_000;

// Écart toléré entre le décalage d'une piste (horodatage dans le résultat
// moins horodatage dans la source) et le décalage de référence, commun à
// toutes les pistes — seul un écart RELATIF est une désynchronisation : un
// décalage identique de toutes les pistes (ex: appliqué par le muxer pour
// éviter un horodatage négatif) ne change rien à la lecture. Pistes copiées
// (audio/sous-titres) : comparées sur leur premier paquet, recopié tel quel.
// Piste vidéo ré-encodée : -copyts conserve l'horodatage de chaque image,
// comparée sur sa DERNIÈRE image — la première peut légitimement manquer
// (images initiales non décodables d'un fichier coupé au milieu d'un GOP,
// écartées par le décodeur sans désynchroniser le reste), d'où une
// tolérance plus large sur le premier paquet vidéo seulement.
const STREAM_PTS_TOLERANCE_S = 0.001;
const VIDEO_FIRST_PTS_TOLERANCE_S = 0.25;
const DURATION_TOLERANCE_S = 1;

const STDERR_TAIL_BYTES = 4000;

// Espace disque laissé libre en permanence sur le volume, en plus du fichier
// temporaire d'encodage : un NAS dont le volume se remplit à 100 % peut
// devenir instable (DSM, autres services), bien au-delà de cette app.
const DISK_RESERVE_BYTES = 2 * 1024 ** 3;

// ffmpeg/ffprobe tournent avec la priorité CPU la plus basse (nice 19) et la
// classe d'E/S disque "idle" (ionice -c 3 : n'accède au disque que quand
// personne d'autre n'en a besoin) — un encodage de plusieurs heures ne doit
// jamais ralentir le NAS lui-même ni ses autres services, quitte à durer
// plus longtemps. En complément des limites dures du conteneur (voir
// docker-compose.yml).
const LOW_PRIORITY_PREFIX = ["nice", "-n", "19", "ionice", "-c", "3"];

class ProcessError extends Error {}

// Lance un process et attend sa fin. Les lignes de stdout sont passées à
// onLine au fil de l'eau (jamais tout gardé en mémoire : la liste des paquets
// d'un film fait des centaines de milliers de lignes) ; seule la fin de
// stderr est conservée, pour le message d'erreur. Sur annulation (signal),
// le process est arrêté et la promesse rejetée seulement une fois qu'il est
// réellement terminé : jamais deux encodages simultanés sur le NAS, ni de
// fichier temporaire supprimé pendant qu'ffmpeg écrit encore dedans.
function runProcess(
  command: string,
  args: string[],
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const [prefix, ...prefixArgs] = LOW_PRIORITY_PREFIX;
    // nice et ionice remplacent leur propre process par la commande (exec) :
    // le pid de "child" est bien celui d'ffmpeg/ffprobe une fois lancé.
    const child = spawn(prefix, [...prefixArgs, command, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // SIGKILL direct plutôt que SIGTERM : sur SIGTERM, ffmpeg vide d'abord
    // les images en attente dans x265 (plusieurs secondes mesurées sur un
    // cœur en priorité minimale) pour un fichier qui sera jeté de toute façon.
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    readline.createInterface({ input: child.stdout }).on("line", onLine);
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new ProcessError(`${prefix} introuvable, impossible de lancer ${command}`)
          : err
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      // 127 : commande introuvable (renvoyé par nice/ionice, qui eux existent).
      else if (code === 127) reject(new ProcessError(`${command} introuvable (ffmpeg n'est pas installé ?)`));
      else reject(new ProcessError(`${command} a échoué (code ${code}) : ${stderrTail.trim()}`));
    });
  });
}

async function probe(filePath: string, signal?: AbortSignal): Promise<Probe> {
  let json = "";
  await runProcess(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    (line) => {
      json += line + "\n";
    },
    signal
  );
  return JSON.parse(json) as Probe;
}

// Nombre de paquets et horodatage du premier paquet de chaque piste — lit
// tout le fichier (démultiplexage seul, sans décodage : rapide).
async function packetStats(filePath: string, signal?: AbortSignal): Promise<PacketStats> {
  const stats: PacketStats = new Map();
  await runProcess(
    "ffprobe",
    ["-v", "error", "-show_entries", "packet=stream_index,pts_time", "-of", "csv=p=0", filePath],
    (line) => {
      const [indexStr, ptsStr] = line.split(",");
      const index = Number(indexStr);
      if (!Number.isInteger(index)) return;
      const pts = Number(ptsStr);
      const entry = stats.get(index) ?? { count: 0, firstPts: null, lastPts: null };
      entry.count++;
      if (Number.isFinite(pts)) {
        if (entry.firstPts == null || pts < entry.firstPts) entry.firstPts = pts;
        if (entry.lastPts == null || pts > entry.lastPts) entry.lastPts = pts;
      }
      stats.set(index, entry);
    },
    signal
  );
  return stats;
}

function isMainVideo(stream: ProbeStream): boolean {
  return stream.codec_type === "video" && stream.disposition?.attached_pic !== 1;
}

// Les pistes "data" (rares, ex: timecodes) ne sont pas recopiées : le muxer
// MKV ne sait pas les écrire. Tout le reste (vidéo, audio, sous-titres,
// pièces jointes) est conservé, dans le même ordre.
function keptStreams(probeResult: Probe): ProbeStream[] {
  return probeResult.streams.filter((s) => s.codec_type !== "data");
}

function streamBitrate(stream: ProbeStream): number | null {
  const raw = stream.bit_rate ?? stream.tags?.BPS ?? stream.tags?.["BPS-eng"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Débit vidéo maximal (bits/s) pour que le fichier final ne dépasse pas
// targetSize (voir videoTargetSize) : budget total sur la durée de la vidéo,
// moins ce que prennent les pistes recopiées telles quelles (audio...).
export function computeVideoMaxrate(targetSize: number, durationS: number, copiedBps: number): number {
  const budgetBps = (targetSize * 8) / durationS - copiedBps;
  return Math.max(MIN_VIDEO_MAXRATE_BPS, Math.floor(budgetBps));
}

// "24000/1001" -> 23.976 ; null si absent/invalide ("0/0").
function parseFrameRate(value: string | undefined): number | null {
  const [num, den] = (value ?? "").split("/").map(Number);
  const rate = num / den;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function verifyOutput(
  source: Probe,
  output: Probe,
  sourcePackets: PacketStats,
  outputPackets: PacketStats
): string[] {
  const problems: string[] = [];
  const expected = keptStreams(source);

  if (output.streams.length !== expected.length) {
    return [`${expected.length} piste(s) attendue(s), ${output.streams.length} dans le résultat`];
  }

  // Décalage de chaque piste (résultat - source) sur le paquet comparé
  // (voir STREAM_PTS_TOLERANCE_S), null si non mesurable (pièce jointe...).
  const shifts = expected.map((src, i) => {
    const srcStats = sourcePackets.get(src.index);
    const outStats = outputPackets.get(output.streams[i].index);
    const key = isMainVideo(src) ? "lastPts" : "firstPts";
    const a = srcStats?.[key];
    const b = outStats?.[key];
    return a != null && b != null ? b - a : null;
  });
  // Référence : le décalage partagé par le plus de pistes (un éventuel
  // décalage global du muxer les touche toutes) — c'est alors la piste qui
  // s'en écarte qui est signalée, pas toutes les autres.
  const measured = shifts.filter((shift): shift is number => shift != null);
  const agreeing = (ref: number) =>
    measured.filter((shift) => Math.abs(shift - ref) <= STREAM_PTS_TOLERANCE_S).length;
  const refShift = measured.reduce(
    (best, shift) => (agreeing(shift) > agreeing(best) ? shift : best),
    measured[0] ?? 0
  );

  expected.forEach((src, i) => {
    const out = output.streams[i];
    const label = `piste ${i} (${src.codec_type}${src.tags?.language ? ` ${src.tags.language}` : ""})`;
    if (out.codec_type !== src.codec_type) {
      problems.push(`${label} : type ${out.codec_type} au lieu de ${src.codec_type}`);
      return;
    }
    const encoded = isMainVideo(src);
    if (!encoded && out.codec_name !== src.codec_name) {
      problems.push(`${label} : codec ${out.codec_name} au lieu de ${src.codec_name}`);
    }

    const srcStats = sourcePackets.get(src.index);
    const outStats = outputPackets.get(out.index);
    if (!encoded && (srcStats?.count ?? 0) !== (outStats?.count ?? 0)) {
      problems.push(`${label} : ${outStats?.count ?? 0} paquet(s) au lieu de ${srcStats?.count ?? 0}`);
    }
    const shift = shifts[i];
    if (shift != null && Math.abs(shift - refShift) > STREAM_PTS_TOLERANCE_S) {
      problems.push(`${label} : décalage relatif de ${(shift - refShift).toFixed(3)} s`);
    }
    if (encoded) {
      const a = srcStats?.firstPts;
      const b = outStats?.firstPts;
      if (a != null && b != null && Math.abs(b - a - refShift) > VIDEO_FIRST_PTS_TOLERANCE_S) {
        problems.push(`${label} : première image décalée de ${(b - a - refShift).toFixed(3)} s`);
      }
    }
  });

  const srcDuration = Number(source.format.duration);
  const outDuration = Number(output.format.duration);
  if (Number.isFinite(srcDuration) && Number.isFinite(outDuration)) {
    if (Math.abs(outDuration - srcDuration) > DURATION_TOLERANCE_S) {
      problems.push(`durée ${outDuration.toFixed(1)} s au lieu de ${srcDuration.toFixed(1)} s`);
    }
  }

  return problems;
}

// <dossier>/<nom>.mkv.bkp, ou <nom>_1.mkv.bkp, <nom>_2.mkv.bkp... si une
// sauvegarde d'un passage précédent existe déjà — jamais écrasée.
function resolveBackupPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // turbopackIgnore : chemin dynamique sous FILES_DIR (volume monté au
  // runtime), jamais un fichier du projet — voir moveToOriginFolder dans
  // optimizeImage.ts pour le contexte complet.
  let target = `${filePath}${VIDEO_BACKUP_SUFFIX}`;
  let counter = 1;
  while (fs.existsSync(/*turbopackIgnore: true*/ target)) {
    target = path.join(/*turbopackIgnore: true*/ dir, `${base}_${counter}${ext}${VIDEO_BACKUP_SUFFIX}`);
    counter++;
  }
  return target;
}

export function partPathFor(filePath: string): string {
  return `${filePath}${VIDEO_PART_SUFFIX}`;
}

// Ré-encode la piste vidéo d'un MKV en x265 (HEVC) pour gagner de la place,
// en recopiant TOUTES les autres pistes à l'identique (audio, sous-titres,
// pièces jointes, chapitres, métadonnées : jamais ré-encodées, jamais
// retirées). -copyts conserve l'horodatage d'origine de chaque paquet (y
// compris un décalage audio volontaire de la source) : sans lui, ffmpeg
// recale la vidéo ré-encodée et les pistes copiées différemment dès que la
// source ne démarre pas pile à 0 (quelques ms d'écart mesurées). Le
// résultat est vérifié (pistes, nombre de paquets, horodatages, durée)
// AVANT de toucher à la source : au moindre écart, la source reste intacte.
export async function optimizeVideo(params: OptimizeVideoParams): Promise<OptimizeVideoResult> {
  const { filePath, crf, preset, profile, keepSource, onProgress, onPercent, signal } = params;
  const originalSize = fs.statSync(filePath).size;

  const source = await probe(filePath, signal);
  const durationS = Number(source.format.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new Error("Durée de la vidéo illisible (fichier corrompu ?)");
  }
  const startS = Number(source.format.start_time) || 0;

  const videoStreams = source.streams.filter(isMainVideo);
  if (videoStreams.length === 0) {
    throw new Error("Aucune piste vidéo dans ce fichier.");
  }
  const sourceCodecs = videoStreams.map((s) => s.codec_name ?? "?");
  if (videoStreams.every((s) => VIDEO_SKIP_CODECS.has(s.codec_name ?? ""))) {
    onProgress?.(
      `déjà en ${sourceCodecs.join("/")} (au moins aussi efficace que x265) : fichier conservé tel quel`
    );
    return { originalSize, optimizedSize: originalSize, finalPath: filePath };
  }

  const copiedBps = keptStreams(source)
    .filter((s) => !isMainVideo(s))
    .reduce((sum, s) => sum + (streamBitrate(s) ?? (s.codec_type === "audio" ? UNKNOWN_AUDIO_BPS : 0)), 0);
  const targetSize = videoTargetSize(originalSize, durationS, profile);
  const maxrateBps = computeVideoMaxrate(targetSize, durationS, copiedBps);
  const maxrateK = Math.round(maxrateBps / 1000);

  const dir = path.dirname(filePath);
  const { bavail, bsize } = fs.statfsSync(dir);
  // Le fichier temporaire coexiste avec la source jusqu'à la fin : il faut
  // la place de la taille cible (+5% de marge) en plus de la source, sans
  // jamais entamer la réserve du volume.
  const neededBytes = targetSize * 1.05 + DISK_RESERVE_BYTES;
  if (bavail * bsize < neededBytes) {
    throw new Error(
      `Espace disque insuffisant : ${Math.round((bavail * bsize) / 1e6)} Mo libres, ${Math.round(
        neededBytes / 1e6
      )} Mo nécessaires (fichier temporaire + réserve de ${DISK_RESERVE_BYTES / 1024 ** 3} Go).`
    );
  }

  // Avancement d'après le nombre d'images encodées : le "out_time" de
  // -progress, lui, reste bloqué dès qu'une piste de sous-titres n'a plus
  // de paquet (mesuré : figé à la dernière réplique jusqu'à la toute fin).
  const fps = parseFrameRate(videoStreams[0].avg_frame_rate) ?? parseFrameRate(videoStreams[0].r_frame_rate);
  const expectedFrames = fps ? durationS * fps : null;

  const streamSummary = keptStreams(source)
    .map((s) => `${s.codec_type}:${s.codec_name ?? "?"}${s.tags?.language ? `(${s.tags.language})` : ""}`)
    .join(", ");
  onProgress?.(`pistes : ${streamSummary}`);
  onProgress?.(
    `encodage x265 (profil ${profile}, CRF ${crf}, preset ${preset}, vidéo ${sourceCodecs.join("/")} -> hevc, débit max ${maxrateK} kb/s pour viser ${Math.round(
      targetSize / 1e6
    )} Mo au plus), autres pistes copiées telles quelles`
  );

  const partPath = partPathFor(filePath);
  try {
    let lastPercentLogged = 0;
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
        "0",
        "-map",
        "-0:d?",
        "-c",
        "copy",
        // "V" (majuscule) : pistes vidéo SAUF images de couverture
        // (attached_pic), qui restent copiées.
        "-c:V",
        "libx265",
        "-crf",
        String(crf),
        "-preset",
        preset,
        "-maxrate",
        `${maxrateK}k`,
        "-bufsize",
        `${maxrateK * 2}k`,
        // pools : x265 dimensionne ses threads (et la mémoire qui va avec)
        // sur le nombre total de cœurs de la machine, en ignorant le cpuset
        // du conteneur (voir docker-compose.yml) ; availableParallelism, lui,
        // le respecte.
        "-x265-params",
        `log-level=error:pools=${os.availableParallelism()}`,
        // Aucune image dupliquée/supprimée : chacune garde son horodatage
        // (vidéos à débit d'images variable comprises).
        "-fps_mode",
        "passthrough",
        "-copyts",
        // Évite "Too many packets buffered for output stream" quand une
        // piste de sous-titres a de longs trous entre deux paquets.
        "-max_muxing_queue_size",
        "4096",
        "-progress",
        "pipe:1",
        "-nostats",
        "-f",
        "matroska",
        partPath,
      ],
      (line) => {
        let ratio: number;
        if (expectedFrames && line.startsWith("frame=")) {
          ratio = Number(line.slice("frame=".length)) / expectedFrames;
        } else if (!expectedFrames && line.startsWith("out_time_us=")) {
          ratio = (Number(line.slice("out_time_us=".length)) / 1e6 - startS) / durationS;
        } else {
          return;
        }
        if (!Number.isFinite(ratio)) return;
        const percent = Math.min(100, Math.max(0, ratio * 100));
        onPercent?.(percent);
        if (percent >= lastPercentLogged + 10) {
          lastPercentLogged = Math.floor(percent / 10) * 10;
          onProgress?.(`encodage : ${lastPercentLogged} %`);
        }
      },
      signal
    );

    onProgress?.("vérification des pistes et de la synchronisation…");
    const output = await probe(partPath, signal);
    // L'un après l'autre (pas en parallèle) : deux lectures complètes
    // simultanées de gros fichiers saturent inutilement le disque du NAS.
    const sourcePackets = await packetStats(filePath, signal);
    const outputPackets = await packetStats(partPath, signal);
    const problems = verifyOutput(source, output, sourcePackets, outputPackets);
    if (problems.length > 0) {
      throw new Error(`Résultat rejeté, source conservée intacte — ${problems.join(" ; ")}`);
    }
    onProgress?.("pistes et synchronisation identiques à la source");

    const optimizedSize = fs.statSync(partPath).size;
    if (optimizedSize >= originalSize) {
      fs.unlinkSync(partPath);
      onProgress?.(
        `déjà optimale (${originalSize} octets, le ré-encodage donnait ${optimizedSize}) : fichier conservé tel quel`
      );
      return { originalSize, optimizedSize: originalSize, finalPath: filePath };
    }
    if (optimizedSize > targetSize) {
      onProgress?.(
        `attention : ${Math.round(optimizedSize / 1e6)} Mo, au-dessus de la cible (${Math.round(
          targetSize / 1e6
        )} Mo) — pistes audio copiées trop lourdes pour l'atteindre ; gardé car plus petit que la source`
      );
    }

    // Dernier point d'annulation : la suite (renommages) est synchrone et
    // quasi instantanée, jamais interrompue à moitié.
    signal?.throwIfAborted();

    if (keepSource) {
      const backupPath = resolveBackupPath(filePath);
      fs.renameSync(filePath, backupPath);
      onProgress?.(`source conservée : ${path.basename(backupPath)}`);
    }
    // Remplace la source (ou prend sa place si elle vient d'être renommée)
    // en une seule opération atomique : jamais d'instant sans fichier.
    fs.renameSync(partPath, filePath);

    return { originalSize, optimizedSize, finalPath: filePath };
  } finally {
    if (fs.existsSync(/*turbopackIgnore: true*/ partPath)) fs.unlinkSync(partPath);
  }
}
