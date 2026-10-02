import { NextResponse } from "next/server";
import { isQueuePaused, setQueuePaused } from "@/lib/queueSettings";

export async function GET() {
  return NextResponse.json({ paused: isQueuePaused() });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body?.paused !== "boolean") {
    return NextResponse.json({ error: "paused doit être un booléen" }, { status: 400 });
  }
  setQueuePaused(body.paused);
  return NextResponse.json({ paused: body.paused });
}
