import { NextResponse } from "next/server";
import { InvalidPathError } from "@/lib/photoBrowse";
import { analyzeVideos } from "@/lib/videoAnalysis";
import { DEFAULT_VIDEO_PROFILE, isVideoProfile } from "@/lib/videoSettings";

// Analyse préalable d'un dossier de vidéos (récursif) : ce qui serait
// ré-encodé ou laissé tel quel, place libérée au minimum, durée estimée —
// sans rien mettre en file ni toucher à aucun fichier.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const relPath = typeof body?.path === "string" ? body.path : "";
  const profile = isVideoProfile(body?.videoProfile) ? body.videoProfile : DEFAULT_VIDEO_PROFILE;

  try {
    return NextResponse.json(await analyzeVideos(relPath, profile));
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }
}
