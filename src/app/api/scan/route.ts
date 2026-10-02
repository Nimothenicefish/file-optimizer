import { NextResponse } from "next/server";
import { DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY } from "@/lib/imageLimits";
import { InvalidPathError, listPhotosRecursive } from "@/lib/photoBrowse";
import { enqueuePhotos } from "@/lib/queue/worker";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Scanne récursivement un dossier (sous-dossiers compris) et met en file
// toutes les photos trouvées (formats pris en charge, voir photoBrowse.ts) —
// pour "optimiser tout ce qu'il y a dans ce dossier" sans sélection manuelle.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPath = typeof body?.path === "string" ? body.path : "";
  const maxDimension = clampInt(body?.maxDimension, DEFAULT_MAX_DIMENSION, 100, 20000);
  const quality = clampInt(body?.quality, DEFAULT_QUALITY, 1, 100);
  const keepOriginal = body?.keepOriginal !== false;

  let files: string[];
  try {
    files = listPhotosRecursive(relPath);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }

  const { queued, skippedAlreadyQueued, ids } = enqueuePhotos(
    files.map((filePath) => ({ filePath, maxDimension, quality, keepOriginal }))
  );

  return NextResponse.json({
    found: files.length,
    queued,
    skippedAlreadyQueued,
    ids,
  });
}
