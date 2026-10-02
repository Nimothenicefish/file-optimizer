import { NextResponse } from "next/server";
import { InvalidPathError, listPhotoEntries } from "@/lib/photoBrowse";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path") ?? "";

  try {
    const entries = listPhotoEntries(relPath);
    return NextResponse.json({ path: relPath, entries });
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return NextResponse.json({ error: "Chemin invalide" }, { status: 400 });
    }
    throw err;
  }
}
