import { NextResponse } from "next/server";
import { parseOptimizeSettings, toEnqueueParams } from "@/lib/optimizeSettings";
import { InvalidPathError, listMediaRecursive } from "@/lib/photoBrowse";
import { enqueueFiles } from "@/lib/queue/worker";
import { parseVideoFormats } from "@/lib/videoSettings";

// Scanne récursivement un dossier (sous-dossiers compris) et met en file
// tous les fichiers du mode choisi ("image" par défaut, ou "video") —
// formats pris en charge, voir photoBrowse.ts — pour "optimiser tout ce
// qu'il y a dans ce dossier" sans sélection manuelle (en mode vidéo,
// éventuellement restreint à certains formats).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPath = typeof body?.path === "string" ? body.path : "";
  const kind = body?.mode === "video" ? "video" : "image";
  const settings = parseOptimizeSettings(body);
  // Vidéos : formats cochés dans l'UI (MKV, MP4, AVI), tous par défaut.
  const formats = kind === "video" ? parseVideoFormats(body?.videoFormats) : null;
  if (formats?.size === 0) {
    return NextResponse.json({ error: "Aucun format vidéo choisi" }, { status: 400 });
  }

  let files: string[];
  try {
    files = listMediaRecursive(relPath, kind, formats);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }

  const { queued, skippedAlreadyQueued, ids } = enqueueFiles(
    files.map((filePath) => toEnqueueParams(filePath, kind, settings))
  );

  return NextResponse.json({
    found: files.length,
    queued,
    skippedAlreadyQueued,
    ids,
  });
}
