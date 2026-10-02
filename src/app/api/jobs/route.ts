import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY } from "@/lib/imageLimits";
import { InvalidPathError, resolvePhotoPath } from "@/lib/photoBrowse";
import { enqueuePhotos } from "@/lib/queue/worker";
import { isQueuePaused } from "@/lib/queueSettings";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
    const jobs = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders})`).all(...ids);
    return NextResponse.json({ jobs });
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
  const jobs = db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

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
// FILES_DIR, choisis en parcourant les dossiers côté UI).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPaths: string[] = Array.isArray(body?.paths) ? body.paths : [];
  if (relPaths.length === 0) {
    return NextResponse.json({ error: "Aucun fichier sélectionné" }, { status: 400 });
  }

  const maxDimension = clampInt(body?.maxDimension, DEFAULT_MAX_DIMENSION, 100, 20000);
  const quality = clampInt(body?.quality, DEFAULT_QUALITY, 1, 100);
  const keepOriginal = body?.keepOriginal !== false;

  let filePaths: string[];
  try {
    filePaths = relPaths.map((p) => resolvePhotoPath(p));
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }

  const { queued, skippedAlreadyQueued, ids } = enqueuePhotos(
    filePaths.map((filePath) => ({ filePath, maxDimension, quality, keepOriginal }))
  );

  return NextResponse.json({ queued, skippedAlreadyQueued, ids });
}
