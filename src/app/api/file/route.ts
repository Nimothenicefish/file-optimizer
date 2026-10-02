import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { InvalidPathError, imageContentType, resolvePhotoPath } from "@/lib/photoBrowse";

// Sert le contenu brut d'une photo (aperçu dans l'UI) — jamais un fichier
// arbitraire : seuls les formats pris en charge (voir IMAGE_EXT) répondent,
// tout le reste est refusé (400), même s'il existe sous FILES_DIR.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path") ?? "";

  let filePath: string;
  try {
    filePath = resolvePhotoPath(relPath);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }

  const contentType = imageContentType(path.basename(filePath));
  if (!contentType) {
    return NextResponse.json({ error: "Format non pris en charge" }, { status: 400 });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return NextResponse.json({ error: "Fichier introuvable" }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": contentType } });
}
