import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestApp, setupTestApp, waitFor } from "../helpers/testApp";

let tmpDir: string;
let photosDir: string;
let fixtureDir: string;
let db: typeof import("@/lib/db").db;
let optimizeAudio: typeof import("@/lib/pipeline/optimizeAudio").optimizeAudio;
let scanRoute: typeof import("@/app/api/scan/route");
let backups: typeof import("@/lib/backups");
let mp3SampleRate: typeof import("@/lib/audioSettings").mp3SampleRate;

type Probed = {
  streams: Array<{ codec_type: string; codec_name: string; sample_rate?: string; channels?: number }>;
  format: { duration: string; tags?: Record<string, string> };
};

function probeFile(file: string): Probed {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(out.toString());
}

// FLAC "réaliste" : tags Vorbis en majuscules (comme les écrivent les
// logiciels d'extraction de CD), total de pistes dans un tag séparé, date
// complète, pochette PNG intégrée.
function makeFlac(
  target: string,
  { sampleRate = 44100, channels = 2, cover = true }: { sampleRate?: number; channels?: number; cover?: boolean } = {}
) {
  const coverPath = path.join(fixtureDir, "cover.png");
  if (!fs.existsSync(coverPath)) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=300x300:duration=1", "-frames:v", "1", coverPath]);
  }
  const layout = channels === 6 ? "5.1" : channels === 1 ? "mono" : "stereo";
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=3:sample_rate=${sampleRate}`,
    ...(cover ? ["-i", coverPath] : []),
    "-map", "0", ...(cover ? ["-map", "1", "-c:v", "copy", "-disposition:v", "attached_pic"] : []),
    "-af", `aformat=channel_layouts=${layout}`,
    "-c:a", "flac",
    "-metadata", "TITLE=Chanson été",
    "-metadata", "ARTIST=Artiste",
    "-metadata", "ALBUM=Album",
    "-metadata", "ALBUMARTIST=Artiste de l'album",
    "-metadata", "DATE=1999-05-10",
    "-metadata", "GENRE=Rock",
    "-metadata", "TRACKNUMBER=3",
    "-metadata", "TRACKTOTAL=12",
    "-metadata", "DISCNUMBER=1",
    "-metadata", "DISCTOTAL=2",
    target,
  ]);
}

beforeAll(async () => {
  ({ tmpDir, photosDir, db } = await setupTestApp("file-optimizer-audio-"));
  fixtureDir = path.join(tmpDir, "fixtures");
  fs.mkdirSync(fixtureDir);
  ({ optimizeAudio } = await import("@/lib/pipeline/optimizeAudio"));
  ({ mp3SampleRate } = await import("@/lib/audioSettings"));
  scanRoute = await import("@/app/api/scan/route");
  backups = await import("@/lib/backups");
});

afterAll(() => {
  cleanupTestApp(tmpDir);
});

describe("optimizeAudio — FLAC -> MP3", () => {
  it("convertit en MP3 du même nom, avec tags, n° de piste/disque complets et pochette", async () => {
    const dir = path.join(photosDir, "album1");
    fs.mkdirSync(dir);
    const flac = path.join(dir, "03 - Chanson.flac");
    makeFlac(flac);
    const flacSize = fs.statSync(flac).size;

    const result = await optimizeAudio({ filePath: flac, quality: "v0", keepSource: true });

    const mp3 = path.join(dir, "03 - Chanson.mp3");
    expect(result).toEqual({ originalSize: flacSize, optimizedSize: fs.statSync(mp3).size, finalPath: mp3 });
    expect(result.optimizedSize).toBeLessThan(flacSize);
    expect(fs.existsSync(flac)).toBe(false);
    expect(fs.existsSync(`${flac}.bkp`)).toBe(true);
    expect(fs.existsSync(`${flac}.part`)).toBe(false);

    const out = probeFile(mp3);
    expect(out.streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["audio:mp3", "video:png"]);
    expect(Number(out.format.duration)).toBeCloseTo(3, 0);
    expect(out.format.tags).toMatchObject({
      title: "Chanson été",
      artist: "Artiste",
      album: "Album",
      album_artist: "Artiste de l'album",
      date: "1999-05-10",
      genre: "Rock",
      track: "3/12",
      disc: "1/2",
    });
  });

  it("supprime le FLAC si sa conservation n'est pas demandée", async () => {
    const dir = path.join(photosDir, "album2");
    fs.mkdirSync(dir);
    const flac = path.join(dir, "piste.flac");
    makeFlac(flac, { cover: false });

    await optimizeAudio({ filePath: flac, quality: "320", keepSource: false });

    expect(fs.readdirSync(dir)).toEqual(["piste.mp3"]);
    const out = probeFile(path.join(dir, "piste.mp3"));
    expect(out.streams.map((s) => s.codec_type)).toEqual(["audio"]);
  });

  it("rééchantillonne la hi-res et réduit le multicanal en stéréo", async () => {
    const dir = path.join(photosDir, "hires");
    fs.mkdirSync(dir);
    const hires = path.join(dir, "hires.flac");
    const surround = path.join(dir, "surround.flac");
    makeFlac(hires, { sampleRate: 96000 });
    makeFlac(surround, { channels: 6 });

    await optimizeAudio({ filePath: hires, quality: "v0", keepSource: false });
    await optimizeAudio({ filePath: surround, quality: "v0", keepSource: false });

    expect(probeFile(path.join(dir, "hires.mp3")).streams[0]).toMatchObject({ sample_rate: "48000" });
    expect(probeFile(path.join(dir, "surround.mp3")).streams[0]).toMatchObject({ channels: 2 });
    expect(mp3SampleRate(44100)).toBeNull();
    expect(mp3SampleRate(88200)).toBe(44100);
    expect(mp3SampleRate(192000)).toBe(48000);
  });

  it("n'écrase jamais un MP3 du même nom : erreur, FLAC intact", async () => {
    const dir = path.join(photosDir, "conflit");
    fs.mkdirSync(dir);
    const flac = path.join(dir, "titre.flac");
    makeFlac(flac, { cover: false });
    fs.writeFileSync(path.join(dir, "titre.mp3"), "autre version");
    const before = fs.readFileSync(flac);

    await expect(optimizeAudio({ filePath: flac, quality: "v0", keepSource: false })).rejects.toThrow(
      /titre\.mp3 existe déjà/
    );
    expect(fs.readFileSync(flac).equals(before)).toBe(true);
    expect(fs.readFileSync(path.join(dir, "titre.mp3"), "utf8")).toBe("autre version");
    expect(fs.existsSync(`${flac}.part`)).toBe(false);
  });
});

describe("scan en mode musique + worker + sauvegardes", () => {
  it("ne trouve que les FLAC, les convertit, et rattache le .flac.bkp à son MP3", async () => {
    const dir = path.join(photosDir, "musique");
    fs.mkdirSync(dir);
    makeFlac(path.join(dir, "a.flac"), { cover: false });
    fs.writeFileSync(path.join(dir, "deja.mp3"), "pas scanné");
    fs.writeFileSync(path.join(dir, "folder.jpg"), "pas scanné en mode musique");
    fs.writeFileSync(path.join(dir, "vieux.flac.bkp"), "sauvegarde, jamais reprise");

    const res = await scanRoute.POST(
      new Request("http://localhost/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "musique", mode: "audio", audioQuality: "v2" }),
      })
    );
    const data = await res.json();
    expect(data.found).toBe(1);
    const jobId = data.ids[0];
    expect(db.prepare("SELECT kind, audio_quality, keep_original FROM jobs WHERE id = ?").get(jobId)).toEqual({
      kind: "audio",
      audio_quality: "v2",
      keep_original: 1, // FLAC conservé par défaut
    });

    await waitFor(
      () => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status !== "pending" &&
        (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status !== "running",
      { timeoutMs: 30000 }
    );
    const job = db.prepare("SELECT status, file_path, error FROM jobs WHERE id = ?").get(jobId) as {
      status: string;
      file_path: string;
      error: string | null;
    };
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    expect(job.file_path).toBe(path.join(dir, "a.mp3"));

    const entry = backups.listBackups().find((b) => b.path === "musique/a.flac.bkp");
    expect(entry).toMatchObject({ kind: "audio", optimizedPath: "musique/a.mp3" });
    // vieux.flac.bkp n'a pas de vieux.mp3 : seule copie, suppression refusée.
    const outcome = backups.deleteBackups(["musique/a.flac.bkp", "musique/vieux.flac.bkp"]);
    expect(outcome.deleted).toBe(1);
    expect(outcome.refused).toEqual([
      { path: "musique/vieux.flac.bkp", reason: "fichier optimisé introuvable : seule copie" },
    ]);
  });
});
