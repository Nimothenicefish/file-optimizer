import { NextResponse } from "next/server";
import { cancelJobs } from "@/lib/queue/jobs";

// Annule des jobs en attente (immédiat) ou en cours (interrompu par le
// worker dans la seconde qui suit — voir cancelJobs).
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  const { cancelled, cancelling } = cancelJobs(ids);
  return NextResponse.json({ cancelled, cancelling });
}
