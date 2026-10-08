import { NextResponse } from "next/server";
import { listBackups } from "@/lib/backups";

export async function GET() {
  const entries = listBackups();
  return NextResponse.json({
    entries,
    totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
  });
}
