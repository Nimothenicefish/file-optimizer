import { describe, expect, it } from "vitest";
import { type EtaJob, activeDurationMs, estimateBatch, runningVideoRemainingMs } from "@/lib/eta";
import { formatRemaining } from "@/lib/format";

const NOW = 10_000_000;
const MIN = 60_000;

function job(partial: Partial<EtaJob>): EtaJob {
  return {
    kind: "image",
    status: "pending",
    file_path: "/x",
    progress: null,
    original_size: null,
    started_at: null,
    finished_at: null,
    paused_at: null,
    paused_ms: 0,
    ...partial,
  };
}

describe("runningVideoRemainingMs — temps restant de l'encodage en cours", () => {
  it("extrapole au prorata : 25 % en 30 min -> 90 min restantes", () => {
    const video = job({ kind: "video", status: "running", progress: 25, started_at: NOW - 30 * MIN });
    expect(runningVideoRemainingMs(video, NOW)).toBe(90 * MIN);
  });

  it("n'estime rien trop tôt (avancement ou temps écoulé insuffisants)", () => {
    const early = job({ kind: "video", status: "running", progress: 0.5, started_at: NOW - 10 * MIN });
    expect(runningVideoRemainingMs(early, NOW)).toBeNull();
    const tooSoon = job({ kind: "video", status: "running", progress: 5, started_at: NOW - 5_000 });
    expect(runningVideoRemainingMs(tooSoon, NOW)).toBeNull();
  });

  it("ne compte pas le temps passé en pause", () => {
    // 60 min depuis le début, dont 20 min de pause terminée et 10 min de
    // pause en cours : 30 min d'encodage effectif pour 25 %.
    const video = job({
      kind: "video",
      status: "running",
      progress: 25,
      started_at: NOW - 60 * MIN,
      paused_ms: 20 * MIN,
      paused_at: NOW - 10 * MIN,
    });
    expect(activeDurationMs(video, NOW)).toBe(30 * MIN);
    expect(runningVideoRemainingMs(video, NOW)).toBe(90 * MIN);
  });
});

describe("estimateBatch — avancement et temps restant d'un lot", () => {
  it("photos : durée moyenne des photos traitées x photos restantes", () => {
    const jobs = [
      job({ status: "done", started_at: NOW - 10_000, finished_at: NOW - 8_000 }),
      job({ status: "done", started_at: NOW - 8_000, finished_at: NOW - 4_000 }),
      job({}),
      job({}),
    ];
    const batch = estimateBatch(jobs, NOW, () => null);
    expect(batch).toMatchObject({ done: 2, total: 4, remainingMs: 6_000 });
    expect(batch.percent).toBe(50);
  });

  it("vidéos : vitesse par octet mesurée, appliquée à la taille des vidéos restantes", () => {
    const sizes: Record<string, number> = { "/en-cours": 2_000, "/suivante": 4_000 };
    const jobs = [
      job({
        kind: "video",
        status: "running",
        file_path: "/en-cours",
        progress: 50,
        started_at: NOW - 20 * MIN,
      }),
      job({ kind: "video", file_path: "/suivante" }),
    ];
    // En cours : 20 min faites + 20 min restantes pour 2000 octets -> la
    // suivante, 2x plus lourde, ~80 min.
    const batch = estimateBatch(jobs, NOW, (p) => sizes[p] ?? null);
    expect(batch.remainingMs).toBe(100 * MIN);
    expect(batch.percent).toBeCloseTo(16.67, 1);
  });

  it("ignore une vidéo déjà en HEVC (terminée en quelques secondes) pour mesurer la vitesse", () => {
    const jobs = [
      job({ kind: "video", status: "done", original_size: 5_000, started_at: NOW - 5_000, finished_at: NOW - 2_000 }),
      job({ kind: "video", file_path: "/suivante" }),
    ];
    expect(estimateBatch(jobs, NOW, () => 5_000).remainingMs).toBeNull();
  });

  it("sans mesure possible : pas de temps restant, avancement en nombre de fichiers", () => {
    const jobs = [job({ status: "error", started_at: NOW - 100, finished_at: NOW }), job({}), job({})];
    const batch = estimateBatch(jobs, NOW, () => null);
    expect(batch.remainingMs).toBeNull();
    expect(batch.percent).toBeCloseTo(33.33, 1);
  });

  it("lot terminé : 100 %", () => {
    const batch = estimateBatch([job({ status: "cancelled" })], NOW, () => null);
    expect(batch).toMatchObject({ done: 1, total: 1, percent: 100 });
  });
});

describe("formatRemaining", () => {
  it("formate en minutes puis en heures", () => {
    expect(formatRemaining(20_000)).toBe("moins d'une minute");
    expect(formatRemaining(12 * MIN)).toBe("≈ 12 min");
    expect(formatRemaining(125 * MIN)).toBe("≈ 2 h 05");
  });
});
