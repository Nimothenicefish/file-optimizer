import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp, waitFor } from "../helpers/testApp";

let tmpDir: string;
let photosDir: string;
let db: typeof import("@/lib/db").db;
let optimizeVideo: typeof import("@/lib/pipeline/optimizeVideo").optimizeVideo;
let computeVideoMaxrate: typeof import("@/lib/pipeline/optimizeVideo").computeVideoMaxrate;
let verifyOutput: typeof import("@/lib/pipeline/optimizeVideo").verifyOutput;
let videoTargetSize: typeof import("@/lib/videoSettings").videoTargetSize;
let describeCrf: typeof import("@/lib/videoSettings").describeCrf;
let DEFAULT_VIDEO_CRF: number;
let scanRoute: typeof import("@/app/api/scan/route");
let cancelRoute: typeof import("@/app/api/jobs/cancel/route");
let setQueuePaused: typeof import("@/lib/queueSettings").setQueuePaused;
let recoverInterruptedJobs: typeof import("@/lib/queue/worker").recoverInterruptedJobs;
let fixtureDir: string;

type ProbeStream = {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

function probeStreams(file: string): ProbeStream[] {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", file]);
  return JSON.parse(out.toString()).streams;
}

// Horodatage du premier paquet et nombre de paquets de chaque piste.
function packetsByStream(file: string): Map<number, { first: number; count: number }> {
  const out = execFileSync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "packet=stream_index,pts_time", "-of", "csv=p=0", file],
    { maxBuffer: 64 * 1024 * 1024 }
  ).toString();
  const result = new Map<number, { first: number; count: number }>();
  for (const line of out.trim().split("\n")) {
    const [idx, pts] = line.split(",").map(Number);
    const entry = result.get(idx) ?? { first: Infinity, count: 0 };
    entry.count++;
    entry.first = Math.min(entry.first, pts);
    result.set(idx, entry);
  }
  return result;
}

// MKV "type film" : vidéo H.264 lourde (CRF bas : gain x265 garanti), deux
// pistes audio dont une volontairement décalée de 0,5 s (doit le rester),
// sous-titres SRT "forcés", pièce jointe (comme une police ASS).
function makeSourceMkv(
  target: string,
  { videoCodec = "libx264", durationS = 5, crf = 8 }: { videoCodec?: string; durationS?: number; crf?: number } = {}
) {
  const srt = path.join(fixtureDir, "subs.srt");
  fs.writeFileSync(
    srt,
    "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n\n2\n00:00:03,000 --> 00:00:04,500\nMonde\n"
  );
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${durationS}`,
    "-itsoffset", "0.5", "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationS - 0.5}`,
    "-f", "lavfi", "-i", `sine=frequency=880:duration=${durationS}`,
    "-i", srt,
    "-map", "0", "-map", "1", "-map", "2", "-map", "3",
    "-c:v", videoCodec, "-crf", String(crf), "-preset", "ultrafast",
    ...(videoCodec === "libx265" ? ["-x265-params", "log-level=error"] : []),
    "-c:a:0", "aac", "-c:a:1", "libopus", "-c:s", "srt",
    "-metadata:s:a:0", "language=fre", "-metadata:s:a:1", "language=eng",
    "-metadata:s:s:0", "language=fre", "-disposition:s:0", "forced",
    "-attach", srt, "-metadata:s:t", "mimetype=text/plain",
    target,
  ]);
}

beforeAll(async () => {
  const app = await setupTestApp("file-optimizer-video-test-");
  tmpDir = app.tmpDir;
  photosDir = app.photosDir;
  db = app.db;
  ({ optimizeVideo, computeVideoMaxrate, verifyOutput } = await import(
    "@/lib/pipeline/optimizeVideo"
  ));
  ({ recoverInterruptedJobs } = await import("@/lib/queue/worker"));
  ({ videoTargetSize, describeCrf, DEFAULT_VIDEO_CRF } = await import("@/lib/videoSettings"));
  scanRoute = await import("@/app/api/scan/route");
  cancelRoute = await import("@/app/api/jobs/cancel/route");
  ({ setQueuePaused } = await import("@/lib/queueSettings"));
  fixtureDir = path.join(tmpDir, "fixtures");
  fs.mkdirSync(fixtureDir);
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("optimizeVideo — ré-encode la vidéo en x265, recopie tout le reste à l'identique", () => {
  it("garde toutes les pistes, leurs métadonnées et leurs horodatages exacts", async () => {
    const filePath = path.join(fixtureDir, "film.mkv");
    makeSourceMkv(filePath);
    const sourceStreams = probeStreams(filePath);
    const sourcePackets = packetsByStream(filePath);
    const sourceSize = fs.statSync(filePath).size;

    const percents: number[] = [];
    const result = await optimizeVideo({
      filePath,
      crf: 28,
      preset: "ultrafast",
      profile: "film",
      keepSource: false,
      onPercent: (p) => percents.push(p),
    });

    expect(result.finalPath).toBe(filePath);
    expect(result.originalSize).toBe(sourceSize);
    expect(result.optimizedSize).toBeLessThan(sourceSize);
    expect(fs.statSync(filePath).size).toBe(result.optimizedSize);
    // Avancement basé sur les images encodées : va jusqu'au bout, même si
    // les sous-titres s'arrêtent avant la fin de la vidéo.
    expect(Math.max(...percents)).toBeGreaterThan(90);

    const outStreams = probeStreams(filePath);
    expect(outStreams.map((s) => s.codec_type)).toEqual(sourceStreams.map((s) => s.codec_type));
    expect(outStreams[0].codec_name).toBe("hevc");
    for (let i = 1; i < sourceStreams.length; i++) {
      expect(outStreams[i].codec_name).toBe(sourceStreams[i].codec_name);
      expect(outStreams[i].tags?.language).toBe(sourceStreams[i].tags?.language);
    }
    const subtitle = outStreams.find((s) => s.codec_type === "subtitle");
    expect(subtitle?.disposition?.forced).toBe(1);

    // Aucun décalage : chaque piste démarre exactement au même instant que
    // dans la source (dont l'audio décalé de 0,5 s), sans paquet perdu.
    const outPackets = packetsByStream(filePath);
    for (const [index, src] of sourcePackets) {
      const out = outPackets.get(index);
      expect(out?.first).toBeCloseTo(src.first, 3);
      if (sourceStreams[index].codec_type !== "video") {
        expect(out?.count).toBe(src.count);
      }
    }

    expect(fs.existsSync(`${filePath}.bkp`)).toBe(false);
    expect(fs.existsSync(`${filePath}.part`)).toBe(false);
  });

  it("conserve la source renommée en .mkv.bkp si demandé, sans écraser une sauvegarde existante", async () => {
    const filePath = path.join(fixtureDir, "serie.mkv");
    makeSourceMkv(filePath);
    const sourceBytes = fs.readFileSync(filePath);

    await optimizeVideo({ filePath, crf: 28, preset: "ultrafast", profile: "film", keepSource: true });
    expect(fs.readFileSync(`${filePath}.bkp`).equals(sourceBytes)).toBe(true);
    expect(probeStreams(filePath)[0].codec_name).toBe("hevc");

    // Second passage sur une nouvelle source du même nom : serie.mkv.bkp
    // existe déjà (premier passage), la nouvelle sauvegarde va à côté.
    makeSourceMkv(filePath);
    await optimizeVideo({ filePath, crf: 28, preset: "ultrafast", profile: "film", keepSource: true });
    expect(fs.readFileSync(`${filePath}.bkp`).equals(sourceBytes)).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, "serie_1.mkv.bkp"))).toBe(true);
  });

  it("laisse intact un fichier déjà en HEVC et déjà compact (rien à gagner)", async () => {
    const filePath = path.join(fixtureDir, "deja-hevc.mkv");
    makeSourceMkv(filePath, { videoCodec: "libx265", crf: 35 });
    const before = fs.readFileSync(filePath);
    const messages: string[] = [];

    const result = await optimizeVideo({
      filePath,
      crf: 22,
      preset: "ultrafast",
      profile: "film",
      keepSource: true,
      onProgress: (m) => messages.push(m),
    });

    expect(result.optimizedSize).toBe(result.originalSize);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
    expect(fs.existsSync(`${filePath}.bkp`)).toBe(false);
    expect(messages.join("\n")).toContain("déjà en hevc et déjà compact");
  });

  it("ré-encode un fichier déjà en HEVC mais encore lourd pour son type", async () => {
    // ~1,4 Go/h attendus au plus pour un film : celui-ci est bien au-dessus.
    const filePath = path.join(fixtureDir, "hevc-lourd.mkv");
    makeSourceMkv(filePath, { videoCodec: "libx265", crf: 0 });
    const sourceSize = fs.statSync(filePath).size;
    const messages: string[] = [];

    const result = await optimizeVideo({
      filePath,
      crf: 28,
      preset: "ultrafast",
      profile: "film",
      keepSource: false,
      onProgress: (m) => messages.push(m),
    });

    expect(messages.join("\n")).toContain("mais encore lourd");
    expect(result.optimizedSize).toBeLessThan(sourceSize);
    expect(probeStreams(filePath)[0].codec_name).toBe("hevc");
  });

  it("ne ré-encode jamais un fichier déjà produit par l'app (tag FILE_OPTIMIZER)", async () => {
    const filePath = path.join(fixtureDir, "deux-passages.mkv");
    makeSourceMkv(filePath, { videoCodec: "libx265", crf: 0 });
    await optimizeVideo({ filePath, crf: 28, preset: "ultrafast", profile: "film", keepSource: false });
    const afterFirst = fs.readFileSync(filePath);
    const messages: string[] = [];

    const second = await optimizeVideo({
      filePath,
      crf: 28,
      preset: "ultrafast",
      profile: "film",
      keepSource: false,
      onProgress: (m) => messages.push(m),
    });

    expect(second.optimizedSize).toBe(second.originalSize);
    expect(fs.readFileSync(filePath).equals(afterFirst)).toBe(true);
    expect(messages.join("\n")).toContain("déjà optimisé par file-optimizer");
  });

  it("échoue sans toucher au fichier s'il n'est pas une vidéo lisible", async () => {
    const filePath = path.join(fixtureDir, "corrompu.mkv");
    fs.writeFileSync(filePath, "pas une vidéo");

    await expect(
      optimizeVideo({ filePath, crf: 22, preset: "ultrafast", profile: "film", keepSource: false })
    ).rejects.toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe("pas une vidéo");
    expect(fs.existsSync(`${filePath}.part`)).toBe(false);
  });
});

// Process ffmpeg encore vivants qui écrivent dans ce fichier (via /proc).
function ffmpegProcessesWriting(target: string): number {
  let count = 0;
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.startsWith("ffmpeg") && cmdline.includes(target)) count++;
    } catch {
      // process terminé entre-temps
    }
  }
  return count;
}

describe("optimizeVideo — annulation en plein encodage", () => {
  it("arrête ffmpeg, supprime le fichier temporaire et laisse la source intacte", async () => {
    const filePath = path.join(fixtureDir, "a-annuler.mkv");
    makeSourceMkv(filePath);
    const before = fs.readFileSync(filePath);
    const controller = new AbortController();

    const promise = optimizeVideo({
      filePath,
      crf: 22,
      preset: "slow",
      profile: "film",
      keepSource: false,
      signal: controller.signal,
      onPercent: (p) => {
        if (p > 0) controller.abort();
      },
    });

    await expect(promise).rejects.toThrow();
    // La promesse n'est rejetée qu'une fois ffmpeg réellement arrêté.
    expect(ffmpegProcessesWriting(`${filePath}.part`)).toBe(0);
    expect(fs.existsSync(`${filePath}.part`)).toBe(false);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });
});

describe("describeCrf — aide de l'UI sur l'effet d'une valeur de CRF", () => {
  it("classe chaque valeur dans la bonne tranche, bornes comprises", () => {
    expect(describeCrf(0).label).toBe("Quasi sans perte");
    expect(describeCrf(17).label).toBe("Quasi sans perte");
    expect(describeCrf(18).label).toBe("Excellente");
    expect(describeCrf(24).label).toBe("Très bonne (recommandé)");
    expect(describeCrf(25).label).toBe("Bonne");
    expect(describeCrf(51).label).toBe("Moyenne à faible");
  });

  it("présente la valeur par défaut comme recommandée", () => {
    expect(describeCrf(DEFAULT_VIDEO_CRF).label).toContain("recommandé");
  });
});

describe("videoTargetSize — taille maximale visée selon le profil", () => {
  const MB = 1024 * 1024;

  it("film : 70 % de la source (4 Go -> 2,8 Go)", () => {
    expect(videoTargetSize(4000 * MB, 7200, "film")).toBe(2800 * MB);
  });

  it("série : ~440 Mo pour 20 min, ~800 Mo pour 50 min", () => {
    expect(videoTargetSize(1500 * MB, 20 * 60, "series")).toBe(440 * MB);
    expect(videoTargetSize(2500 * MB, 50 * 60, "series")).toBe(800 * MB);
  });

  it("série : jamais plus de 70 % d'une source déjà légère", () => {
    expect(videoTargetSize(400 * MB, 20 * 60, "series")).toBe(280 * MB);
  });
});

describe("computeVideoMaxrate — plafond de débit vidéo pour tenir la taille visée", () => {
  it("2,8 Go visés, 2 h, 640 kb/s d'audio copié -> ~2,7 Mb/s de vidéo max", () => {
    const fourGb = 4 * 1024 ** 3;
    const bps = computeVideoMaxrate(fourGb * 0.7, 7200, 640_000);
    // Taille max résultante : (vidéo + audio) x durée <= 70 % de la source.
    expect(((bps + 640_000) * 7200) / 8).toBeLessThanOrEqual(fourGb * 0.7);
    expect(bps).toBeGreaterThan(2_600_000);
  });

  it("ne descend jamais sous un plancher (audio trop lourd pour tenir la cible)", () => {
    expect(computeVideoMaxrate(1_000_000_000, 7200, 50_000_000)).toBe(500_000);
  });
});

describe("verifyOutput — ne tolère qu'un décalage commun à toutes les pistes", () => {
  const probe = (videoCodec: string) => ({
    format: { duration: "100" },
    streams: [
      { index: 0, codec_type: "video", codec_name: videoCodec },
      { index: 1, codec_type: "audio", codec_name: "ac3", tags: { language: "fre" } },
      { index: 2, codec_type: "subtitle", codec_name: "subrip" },
    ],
  });
  // [premier, dernier] horodatage de chaque piste, + un décalage par piste.
  const packets = (shifts: [number, number, number]) =>
    new Map([
      [0, { count: 2500, firstPts: 0 + shifts[0], lastPts: 99.96 + shifts[0] }],
      [1, { count: 3125, firstPts: 0.5 + shifts[1], lastPts: 99.98 + shifts[1] }],
      [2, { count: 40, firstPts: 12 + shifts[2], lastPts: 95 + shifts[2] }],
    ]);

  it("accepte un résultat identique, ou décalé en bloc (toutes les pistes ensemble)", () => {
    const same = verifyOutput(probe("h264"), probe("hevc"), packets([0, 0, 0]), packets([0, 0, 0]));
    expect(same).toEqual([]);
    expect(
      verifyOutput(probe("h264"), probe("hevc"), packets([0, 0, 0]), packets([0.007, 0.007, 0.007]))
    ).toEqual([]);
  });

  it("rejette une piste audio ou de sous-titres décalée par rapport aux autres", () => {
    const source = packets([0, 0, 0]);
    const audio = verifyOutput(probe("h264"), probe("hevc"), source, packets([0, 0.007, 0]));
    expect(audio).toHaveLength(1);
    expect(audio[0]).toContain("audio fre");
    const video = verifyOutput(probe("h264"), probe("hevc"), source, packets([0.04, 0, 0]));
    expect(video).toHaveLength(1);
    expect(video[0]).toContain("video");
  });

  it("rejette une piste manquante ou un paquet perdu", () => {
    const missing = { ...probe("hevc"), streams: probe("hevc").streams.slice(0, 2) };
    const result = verifyOutput(probe("h264"), missing, packets([0, 0, 0]), packets([0, 0, 0]));
    expect(result).toHaveLength(1);
    const lost = packets([0, 0, 0]);
    lost.get(1)!.count--;
    expect(verifyOutput(probe("h264"), probe("hevc"), packets([0, 0, 0]), lost).join()).toContain(
      "paquet"
    );
  });
});

describe("worker + scan en mode vidéo", () => {
  it("le scan 'video' ne trouve que les MKV, et le worker les encode jusqu'au bout", async () => {
    const dir = path.join(photosDir, "films");
    fs.mkdirSync(dir);
    makeSourceMkv(path.join(dir, "film.mkv"));
    fs.writeFileSync(path.join(dir, "ancien.mkv.bkp"), "sauvegarde");
    fs.writeFileSync(path.join(dir, "affiche.jpg"), "pas scanné en mode vidéo");

    const res = await scanRoute.POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "films",
          mode: "video",
          videoCrf: 30,
          videoPreset: "faster",
          videoProfile: "series",
        }),
      })
    );
    const data = await res.json();
    expect(data.found).toBe(1);

    const jobId = data.ids[0];
    const job = db
      .prepare(
        "SELECT kind, video_crf, video_preset, video_profile, keep_original FROM jobs WHERE id = ?"
      )
      .get(jobId);
    expect(job).toEqual({
      kind: "video",
      video_crf: 30,
      video_preset: "faster",
      video_profile: "series",
      keep_original: 0,
    });

    await waitFor(
      () => {
        const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
        return row.status === "done";
      },
      { timeoutMs: 60000 }
    );
    expect(probeStreams(path.join(dir, "film.mkv"))[0].codec_name).toBe("hevc");
  }, 70000);

  it("annule un job vidéo en cours depuis l'API : statut 'cancelled', source intacte", async () => {
    const dir = path.join(photosDir, "annulation");
    fs.mkdirSync(dir);
    const filePath = path.join(dir, "long.mkv");
    makeSourceMkv(filePath);
    const before = fs.readFileSync(filePath);

    const res = await scanRoute.POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "annulation", mode: "video", videoPreset: "slow" }),
      })
    );
    const jobId = (await res.json()).ids[0];
    const status = () =>
      (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;

    await waitFor(() => fs.existsSync(`${filePath}.part`), { timeoutMs: 30000 });
    const cancelRes = await cancelRoute.POST(
      new Request("http://localhost/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [jobId] }),
      })
    );
    expect(await cancelRes.json()).toEqual({ cancelled: 0, cancelling: 1 });

    await waitFor(() => status() === "cancelled", { timeoutMs: 30000 });
    const job = db.prepare("SELECT log FROM jobs WHERE id = ?").get(jobId) as { log: string };
    expect(job.log).toContain("ANNULÉ");
    expect(fs.existsSync(`${filePath}.part`)).toBe(false);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  }, 70000);

  it("pause de la file : gèle l'encodage en cours puis le reprend sans rien perdre", async () => {
    const dir = path.join(photosDir, "pause");
    fs.mkdirSync(dir);
    const filePath = path.join(dir, "film.mkv");
    // Plus longue que les autres : l'encodage doit durer le temps de la pause.
    makeSourceMkv(filePath, { durationS: 30 });
    const partPath = `${filePath}.part`;

    const res = await scanRoute.POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "pause", mode: "video", videoPreset: "slow" }),
      })
    );
    const jobId = (await res.json()).ids[0];
    const row = () =>
      db.prepare("SELECT status, paused_at, paused_ms, log FROM jobs WHERE id = ?").get(jobId) as {
        status: string;
        paused_at: number | null;
        paused_ms: number;
        log: string;
      };

    await waitFor(() => fs.existsSync(partPath) && fs.statSync(partPath).size > 0, {
      timeoutMs: 30000,
    });
    setQueuePaused(true);
    try {
      await waitFor(() => row().paused_at != null, { timeoutMs: 5000 });
      // Gelé : le fichier temporaire ne grossit plus, le job reste "running".
      await new Promise((r) => setTimeout(r, 500));
      const frozenSize = fs.statSync(partPath).size;
      await new Promise((r) => setTimeout(r, 2000));
      expect(fs.statSync(partPath).size).toBe(frozenSize);
      expect(row().status).toBe("running");
    } finally {
      setQueuePaused(false);
    }

    await waitFor(() => row().status === "done", { timeoutMs: 60000 });
    const job = row();
    expect(job.paused_at).toBeNull();
    expect(job.paused_ms).toBeGreaterThanOrEqual(2000);
    expect(job.log).toContain("mis en pause");
    expect(job.log).toContain("repris");
    // La vérification habituelle (pistes, paquets, synchro) est passée.
    expect(job.log).toContain("pistes et synchronisation identiques à la source");
    expect(probeStreams(filePath)[0].codec_name).toBe("hevc");
  }, 90000);

  it("supprime le fichier temporaire d'un encodage interrompu par un redémarrage", () => {
    const filePath = path.join(fixtureDir, "interrompu.mkv");
    fs.writeFileSync(filePath, "source");
    fs.writeFileSync(`${filePath}.part`, "encodage incomplet");
    db.prepare(
      `INSERT INTO jobs (id, file_path, kind, status, max_dimension, quality, keep_original)
       VALUES ('interrompu', ?, 'video', 'running', 0, 0, 0)`
    ).run(filePath);

    recoverInterruptedJobs();

    expect(fs.existsSync(`${filePath}.part`)).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe("source");
  });
});
