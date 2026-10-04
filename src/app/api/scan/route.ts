import { NextResponse } from "next/server";
import { parseOptimizeSettings, toEnqueueParams } from "@/lib/optimizeSettings";
import { InvalidPathError, listMediaRecursive } from "@/lib/photoBrowse";
import { enqueueFiles } from "@/lib/queue/worker";

// Scanne récursivement un dossier (sous-dossiers compris) et met en file
// tous les fichiers du mode choisi ("image" par défaut, ou "video") —
// formats pris en charge, voir photoBrowse.ts — pour "optimiser tout ce
// qu'il y a dans ce dossier" sans sélection manuelle.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPath = typeof body?.path === "string" ? body.path : "";
  const kind = body?.mode === "video" ? "video" : "image";
  const settings = parseOptimizeSettings(body);

  let files: string[];
  try {
    files = listMediaRecursive(relPath, kind);
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
