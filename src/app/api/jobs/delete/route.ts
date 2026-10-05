import { NextResponse } from "next/server";
import { deleteJobs } from "@/lib/queue/jobs";

// Supprime des jobs terminés/en erreur/annulés précis (bouton par ligne sur
// /jobs) ; un job en attente ou en cours est ignoré.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  const deleted = deleteJobs(ids);
  return NextResponse.json({ deleted });
}
