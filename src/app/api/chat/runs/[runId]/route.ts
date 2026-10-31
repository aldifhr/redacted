import { NextResponse } from "next/server";
import { guardApi } from "@/lib/api-guard";
import { readRunLog } from "@/lib/run-log";

// GET /api/chat/runs/[runId] - replay a run's event log.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const blocked = guardApi(req, { scope: "runs", limit: 240 });
  if (blocked) return blocked;
  const { runId } = await params;
  try {
    const { meta, events } = await readRunLog(runId);
    if (!meta) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json({ meta, events });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to read run" },
      { status: 400 }
    );
  }
}
