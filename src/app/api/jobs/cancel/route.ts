import { NextResponse } from "next/server";
import { cancelPendingJobs } from "@/lib/queue/jobs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  const cancelled = cancelPendingJobs(ids);
  return NextResponse.json({ cancelled });
}
