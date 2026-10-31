import { NextResponse } from "next/server";
import { guardApi } from "@/lib/api-guard";
import { listRuns } from "@/lib/run-log";

// GET /api/chat/runs?sessionId=... - recent durable chat runs (live + ended).
export async function GET(req: Request) {
  const blocked = guardApi(req, { scope: "runs", limit: 120 });
  if (blocked) return blocked;
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  const runs = await listRuns();
  return NextResponse.json({
    runs: sessionId ? runs.filter((run) => run.sessionId === sessionId) : runs,
  });
}
