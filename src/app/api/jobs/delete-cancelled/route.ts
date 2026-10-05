import { NextResponse } from "next/server";
import { deleteCancelledJobs } from "@/lib/queue/jobs";

export async function POST() {
  const deleted = deleteCancelledJobs();
  return NextResponse.json({ deleted });
}
