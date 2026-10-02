import { NextResponse } from "next/server";
import { deletePendingJobs } from "@/lib/queue/jobs";

export async function POST() {
  const deleted = deletePendingJobs();
  return NextResponse.json({ deleted });
}
