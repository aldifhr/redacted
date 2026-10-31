import { promises as fs } from "node:fs";
import { join } from "node:path";

// Append-only, full-fidelity evidence store (audit phase 3, layer E).
//
// Independent from LLM conversation context: entries are NEVER deleted
// when they leave the active context window, and payloads are stored
// complete — no truncation here. Compaction (phase 4/5) removes raw
// observations from the model context while this store keeps them
// retrievable by evidence ID.
//
// Layout: <dir>/<runId>.jsonl — one JSON record per line.
// Dir override: EVIDENCE_DIR (tests); default .runs/evidence under cwd.

const DEFAULT_DIR = join(process.cwd(), ".runs", "evidence");

export type EvidenceKind =
  | "snapshot"
  | "text"
  | "screenshot"
  | "action"
  | "assert"
  | "console"
  | "network"
  | "navigation"
  | "artifact";

export type EvidenceRecord = {
  /** Stable per-run id (ev_1, ev_2, …) referenced by summaries/reports. */
  id: string;
  runId: string;
  kind: EvidenceKind;
  tool: string;
  url: string;
  selector?: string;
  pass?: boolean;
  /** Full payload — never truncated by this module. */
  data: unknown;
  chars: number;
  at: number;
};

function dir(): string {
  return process.env.EVIDENCE_DIR ?? DEFAULT_DIR;
}

function fileFor(runId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error("invalid run id");
  return join(dir(), `${runId}.jsonl`);
}

const counters = new Map<string, number>();

function measure(data: unknown): number {
  try {
    return typeof data === "string" ? data.length : JSON.stringify(data)?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function appendEvidence(
  runId: string,
  entry: {
    kind: EvidenceKind;
    tool: string;
    url: string;
    selector?: string;
    pass?: boolean;
    data: unknown;
  }
): Promise<EvidenceRecord> {
  const n = (counters.get(runId) ?? 0) + 1;
  counters.set(runId, n);
  const record: EvidenceRecord = {
    id: `ev_${n}`,
    runId,
    kind: entry.kind,
    tool: entry.tool,
    url: entry.url,
    ...(entry.selector ? { selector: entry.selector } : {}),
    ...(entry.pass !== undefined ? { pass: entry.pass } : {}),
    data: entry.data,
    chars: measure(entry.data),
    at: Date.now(),
  };
  await fs.mkdir(dir(), { recursive: true });
  await fs.appendFile(fileFor(runId), JSON.stringify(record) + "\n", "utf-8");
  return record;
}

export type EvidenceFilter = {
  kind?: EvidenceKind;
  tool?: string;
  url?: string;
};

export async function readEvidence(runId: string, filter?: EvidenceFilter): Promise<EvidenceRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(runId), "utf-8");
  } catch {
    return [];
  }
  const out: EvidenceRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as EvidenceRecord;
      if (!rec || typeof rec.id !== "string") continue;
      if (filter?.kind && rec.kind !== filter.kind) continue;
      if (filter?.tool && rec.tool !== filter.tool) continue;
      if (filter?.url && rec.url !== filter.url) continue;
      out.push(rec);
    } catch {
      // skip corrupt line — the store is append-only, never rewritten
    }
  }
  return out;
}

export async function getEvidence(runId: string, id: string): Promise<EvidenceRecord | null> {
  const all = await readEvidence(runId);
  return all.find((r) => r.id === id) ?? null;
}

export async function countEvidence(runId: string): Promise<number> {
  return (await readEvidence(runId)).length;
}

/** One-line compact reference for LLM context — never the raw payload. */
export function evidenceRef(record: EvidenceRecord): string {
  const path = (() => {
    try {
      return new URL(record.url).pathname || record.url;
    } catch {
      return record.url;
    }
  })();
  let line = `${record.id} ${record.kind} ${path}`;
  if (record.selector) line += ` [${record.selector}]`;
  if (record.pass !== undefined) line += record.pass ? " PASS" : " FAIL";
  line += ` (${record.chars.toLocaleString()} chars)`;
  return line;
}

/** Test/cleanup helper: drop a run's evidence file and reset its counter. */
export async function clearEvidence(runId: string): Promise<void> {
  counters.delete(runId);
  await fs.rm(fileFor(runId), { force: true });
}
