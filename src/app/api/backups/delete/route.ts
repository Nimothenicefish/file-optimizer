import { NextResponse } from "next/server";
import { deleteBackups } from "@/lib/backups";

// Supprime des sauvegardes choisies sur /backups (revérifiées une à une, voir
// deleteBackups) ; les refus sont renvoyés avec leur raison.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const paths: string[] = Array.isArray(body?.paths)
    ? body.paths.filter((p: unknown) => typeof p === "string")
    : [];
  return NextResponse.json(deleteBackups(paths));
}
