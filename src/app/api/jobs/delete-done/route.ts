import { NextResponse } from "next/server";
import { deleteDoneJobs } from "@/lib/queue/jobs";

export async function POST() {
  const deleted = deleteDoneJobs();
  return NextResponse.json({ deleted });
}
