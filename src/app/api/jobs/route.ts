import { NextResponse } from "next/server";
import fs from "node:fs";
import { db } from "@/lib/db";
import { type EtaJob, estimateBatch, runningVideoRemainingMs } from "@/lib/eta";
import { parseOptimizeSettings, toEnqueueParams } from "@/lib/optimizeSettings";
import { InvalidPathError, mediaKind, resolvePhotoPath } from "@/lib/photoBrowse";
import { enqueueFiles } from "@/lib/queue/worker";
import { isQueuePaused } from "@/lib/queueSettings";

function fileSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  // Récupération ciblée d'un lot de jobs par id (suivi de la progression
  // d'un batch scan/optimisation depuis la page de navigation) — pas de
  // pagination ni de filtre de statut dans ce cas, on veut tout le lot.
  const idsParam = searchParams.get("ids") ?? "";
  if (idsParam) {
    const ids = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return NextResponse.json({ jobs: [] });
    const placeholders = ids.map(() => "?").join(",");
    const jobs = db
      .prepare(`SELECT * FROM jobs WHERE id IN (${placeholders})`)
      .all(...ids) as EtaJob[];
    return NextResponse.json({
      jobs,
      batch: estimateBatch(jobs, Date.now(), fileSize),
      paused: isQueuePaused(),
    });
  }

  const status = searchParams.get("status") ?? "";
  const page = Math.max(1, Math.trunc(Number(searchParams.get("page")) || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Math.trunc(Number(searchParams.get("pageSize")) || 25))
  );

  const where = status ? "WHERE status = ?" : "";
  const params = status ? [status] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM jobs ${where}`).get(...params) as { c: number }
  ).c;

  const offset = (page - 1) * pageSize;
  const now = Date.now();
  const jobs = (
    db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as EtaJob[]
  ).map((job) => ({ ...job, remaining_ms: runningVideoRemainingMs(job, now) }));

  const statusCountRows = db
    .prepare("SELECT status, COUNT(*) as count FROM jobs GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  const statusCounts: Record<string, number> = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  };
  for (const row of statusCountRows) statusCounts[row.status] = row.count;

  return NextResponse.json({ jobs, total, page, pageSize, statusCounts, paused: isQueuePaused() });
}

// Met en file une sélection manuelle de fichiers (chemins relatifs à
// FILES_DIR, choisis en parcourant les dossiers côté UI). Photo ou vidéo
// d'après l'extension de chaque fichier ; un format non pris en charge est
// ignoré.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPaths: string[] = Array.isArray(body?.paths) ? body.paths : [];
  if (relPaths.length === 0) {
    return NextResponse.json({ error: "Aucun fichier sélectionné" }, { status: 400 });
  }

  const settings = parseOptimizeSettings(body);

  let filePaths: string[];
  try {
    filePaths = relPaths.map((p) => resolvePhotoPath(p));
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }

  const { queued, skippedAlreadyQueued, ids } = enqueueFiles(
    filePaths.flatMap((filePath) => {
      const kind = mediaKind(filePath);
      return kind ? [toEnqueueParams(filePath, kind, settings)] : [];
    })
  );

  return NextResponse.json({ queued, skippedAlreadyQueued, ids });
}
