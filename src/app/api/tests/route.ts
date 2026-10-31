import { NextResponse } from "next/server";
import { z } from "zod";
import { listSpecs, readSpec, deleteSpec, deleteCases, readCaseResults, readCasesWithResults, saveCaseResults, saveCases, saveSpec, clearRunLog, runSpec, recordRun, loadLastRun, loadRunLog } from "@/lib/specs";
import { guardApi } from "@/lib/api-guard";

const TestsBodySchema = z.object({
  action: z.enum(["get", "delete", "cases", "results", "record", "import", "save", "clear-history", "run"]).optional(),
  file: z.string().max(200).optional(),
  content: z.string().max(200_000).optional(),
  lastFailed: z.boolean().optional(),
  results: z.array(z.object({
    id: z.string().max(20),
    status: z.string().max(10),
    actual: z.string().max(500).optional(),
  })).max(50).optional(),
  cases: z.array(z.object({
    id: z.string().max(20),
    area: z.string().max(60).optional().default(""),
    type: z.string().max(20).optional().default("Positive"),
    title: z.string().max(160),
    preconditions: z.string().max(300).optional().default(""),
    testData: z.string().max(300).optional().default(""),
    steps: z.array(z.string().max(300)).max(20),
    expected: z.string().max(300),
    priority: z.string().max(10).optional().default("Medium"),
    severity: z.string().max(10).optional().default("Medium"),
  })).max(50).optional(),
});

export const maxDuration = 300;


export async function GET(req: Request) {
  const blocked = guardApi(req, { scope: "tests" });
  if (blocked) return blocked;
  try {
    const tests = await listSpecs();
    const lastRun = await loadLastRun();
    // buang hasil run untuk file yang sudah dihapus
    const names = new Set(tests.map((t) => t.file));
    for (const k of Object.keys(lastRun)) {
      if (k !== "__all__" && !names.has(k)) delete lastRun[k];
    }
    return NextResponse.json({ tests, lastRun, history: await loadRunLog() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const blocked = guardApi(req, { scope: "tests" });
  if (blocked) return blocked;
  const parsed = TestsBodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
  const body = parsed.data;
  try {
    switch (body.action) {
      case "get": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        return NextResponse.json({
          file: body.file,
          content: await readSpec(body.file),
        });
      }
      case "delete": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        await deleteCases(body.file);
        return NextResponse.json(await deleteSpec(body.file));
      }
      case "cases": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        return NextResponse.json({ cases: await readCasesWithResults(body.file) });
      }
      case "results": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        return NextResponse.json({ results: await readCaseResults(body.file) });
      }
      case "record": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        if (!body.results?.length) {
           return NextResponse.json({ error: "results are required" }, { status: 400 });
        }
        return NextResponse.json(await saveCaseResults(body.file, body.results));
      }
      case "import": {        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        if (!body.cases?.length) {
           return NextResponse.json({ error: "cases are required" }, { status: 400 });
        }
        // saveCases re-validates everything (ids, titles, steps, expected).
        return NextResponse.json(await saveCases(body.file, body.cases as Parameters<typeof saveCases>[1]));
      }
      case "save": {
        if (!body.file) {
           return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        if (!body.content?.trim()) {
           return NextResponse.json({ error: "content is required" }, { status: 400 });
        }
        // saveSpec re-validates (suffix, @playwright/test import, test() call).
        return NextResponse.json(await saveSpec(body.file, body.content));
      }
      case "run": {
        const summary = await runSpec(body.file || undefined, { lastFailed: body.lastFailed });
        await recordRun(body.file || null, summary);
        return NextResponse.json(summary);
      }
      case "clear-history": {
        return NextResponse.json(await clearRunLog());
      }
      default:
        return NextResponse.json({ tests: await listSpecs() });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
