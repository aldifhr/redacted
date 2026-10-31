import { promises as fs } from "node:fs";
import { join } from "node:path";

// Server-only: durable per-run event log so a chat run survives a page reload.
// Layout: .runs/<runId>.jsonl (events) + .runs/<runId>.meta.json (summary).

const DIR = join(process.cwd(), ".runs");
const MAX_BYTES = 512 * 1024;
const STALE_MS = 30 * 60 * 1000;

export type RunStatus = "running" | "done" | "aborted" | "error";
export type RunMeta = {
  runId: string;
  sessionId: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
};
export type RunEvent = { type: string; data: unknown; at: number };

const queues = new Map<string, Promise<void>>();

function assertId(runId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error("invalid run id");
}

const metaPath = (runId: string) => join(DIR, `${runId}.meta.json`);
const logPath = (runId: string) => join(DIR, `${runId}.jsonl`);

function serial(runId: string, job: () => Promise<void>) {
  const prev = queues.get(runId) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => {});
  queues.set(runId, next);
  void next.finally(() => {
    if (queues.get(runId) === next) queues.delete(runId);
  });
  return next;
}

export async function startRunLog(runId: string, sessionId: string) {
  assertId(runId);
  await fs.mkdir(DIR, { recursive: true });
  const meta: RunMeta = { runId, sessionId, startedAt: Date.now(), status: "running" };
  await fs.writeFile(metaPath(runId), JSON.stringify(meta), "utf-8");
  await fs.writeFile(logPath(runId), "", "utf-8");
}

export function logRunEvent(runId: string, type: string, data: unknown) {
  if (type === "init") return;
  assertId(runId);
  return serial(runId, async () => {
    let line = JSON.stringify({ type, data, at: Date.now() });
    if (line.length > MAX_BYTES) {
      // Screenshot data URLs are the only routinely huge payload: keep the
      // text/tool metadata so a resumed run still renders meaningfully.
      line = JSON.stringify({
        type,
        at: Date.now(),
        data: {
          ...(data && typeof data === "object" ? (data as Record<string, unknown>) : { value: data }),
          screenshots: [],
          truncated: true,
        },
      });
    }
    await fs.appendFile(logPath(runId), line + "\n", "utf-8");
  });
}

export async function finishRunLog(runId: string, status: RunStatus) {
  assertId(runId);
  return serial(runId, async () => {
    try {
      const raw = await fs.readFile(metaPath(runId), "utf-8");
      const meta = JSON.parse(raw) as RunMeta;
      meta.status = status;
      meta.finishedAt = Date.now();
      await fs.writeFile(metaPath(runId), JSON.stringify(meta), "utf-8");
    } catch {}
  });
}

export async function readRunLog(runId: string): Promise<{ meta: RunMeta | null; events: RunEvent[] }> {
  assertId(runId);
  let meta: RunMeta | null = null;
  try {
    meta = JSON.parse(await fs.readFile(metaPath(runId), "utf-8")) as RunMeta;
  } catch {}
  let events: RunEvent[] = [];
  try {
    const raw = await fs.readFile(logPath(runId), "utf-8");
    events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const e = JSON.parse(line) as RunEvent;
          return e && typeof e.type === "string" ? e : null;
        } catch {
          return null;
        }
      })
      .filter((e): e is RunEvent => e !== null);
  } catch {}
  // Server restart: a "running" meta with no terminal event is stale.
  if (meta?.status === "running") {
    const ended = events.some((e) => e.type === "done" || e.type === "aborted" || e.type === "error");
    if (ended) meta.status = "done";
    else if (Date.now() - meta.startedAt > STALE_MS) meta.status = "error";
  }
  return { meta, events };
}

export async function listRuns(limit = 30): Promise<RunMeta[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(DIR);
  } catch {
    return [];
  }
  const metas: RunMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(await fs.readFile(join(DIR, name), "utf-8")) as RunMeta;
      if (!meta?.runId) continue;
      if (meta.status === "running" && Date.now() - meta.startedAt > STALE_MS) {
        meta.status = "error";
      }
      metas.push(meta);
    } catch {}
  }
  metas.sort((a, b) => b.startedAt - a.startedAt);
  return metas.slice(0, limit);
}
