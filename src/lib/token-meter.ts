// Centralized LLM token accounting — one record per provider request.
//
// Provider usage metadata is authoritative. When a provider omits it, sizes
// are estimated from request/response character counts and flagged
// `estimated` so no estimate is ever presented as an exact count.
//
// Scope: in-memory per-run accumulation for the lifetime of a run. The
// aggregate is shipped in the SSE `done` payload and the `usage` event;
// nothing here persists prompts, responses, or credentials.

export type TokenPhase = "PLANNING" | "EXPLORATION" | "VERIFICATION" | "REPORTING";

export type TokenRecord = {
  runId: string;
  phase: TokenPhase;
  round: number;
  agent: "main" | "sub";
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  totalTokens: number;
  estimated: boolean;
  durationMs: number;
  status: "ok" | "error";
  at: number;
};

export type PhaseTokens = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
};

export type RunTokenStats = {
  runId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedTokens: number;
  totalTokens: number;
  byPhase: Record<TokenPhase, PhaseTokens>;
  rounds: number;
  largestRequest: { totalTokens: number; phase: TokenPhase; round: number } | null;
  largestToolResult: { tool: string; chars: number; estimatedTokens: number } | null;
  browserActions: number;
  startedAt: number;
  updatedAt: number;
};

const PHASES: TokenPhase[] = ["PLANNING", "EXPLORATION", "VERIFICATION", "REPORTING"];

// ~4 chars/token is the standard rough ratio for English + code. Only used
// when the provider exposes no usage metadata.
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function emptyPhase(): PhaseTokens {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
}

function emptyStats(runId: string): RunTokenStats {
  return {
    runId,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    estimatedTokens: 0,
    totalTokens: 0,
    byPhase: {
      PLANNING: emptyPhase(),
      EXPLORATION: emptyPhase(),
      VERIFICATION: emptyPhase(),
      REPORTING: emptyPhase(),
    },
    rounds: 0,
    largestRequest: null,
    largestToolResult: null,
    browserActions: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Bounded: keep the most recent runs so a long-lived server cannot leak.
const MAX_RUNS = 50;
const runs = new Map<string, { stats: RunTokenStats; records: TokenRecord[] }>();

function touch(runId: string) {
  let entry = runs.get(runId);
  if (!entry) {
    entry = { stats: emptyStats(runId), records: [] };
    runs.set(runId, entry);
    if (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest && oldest !== runId) runs.delete(oldest);
    }
  }
  return entry;
}

export type TokenUsageInput = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
};

export type RecordTokenUsageInput = {
  runId: string;
  phase: TokenPhase;
  round: number;
  agent: "main" | "sub";
  model: string;
  provider: string;
  usage?: TokenUsageInput;
  // Fallback sizing when the provider exposes no usage metadata.
  requestChars?: number;
  responseChars?: number;
  durationMs: number;
  status?: "ok" | "error";
};

/** Record exactly one provider request. Returns the stored record. */
export function recordTokenUsage(entry: RecordTokenUsageInput): TokenRecord {
  const { stats, records } = touch(entry.runId);
  const usage = entry.usage ?? {};

  const exactInput = Number.isFinite(usage.inputTokens) ? Math.max(0, Math.floor(usage.inputTokens!)) : null;
  const exactOutput = Number.isFinite(usage.outputTokens) ? Math.max(0, Math.floor(usage.outputTokens!)) : null;

  const inputTokens = exactInput ?? estimateTokens(entry.requestChars ?? 0);
  const outputTokens = exactOutput ?? estimateTokens(entry.responseChars ?? 0);
  const estimated = exactInput === null || exactOutput === null;

  const cached =
    Number.isFinite(usage.cachedInputTokens) ? Math.max(0, Math.floor(usage.cachedInputTokens!)) : null;

  // Only the estimated SIDE counts toward estimatedTokens: a record with
  // exact input but missing output usage contributes just its output.
  const estimatedPortion =
    (exactInput === null ? inputTokens : 0) + (exactOutput === null ? outputTokens : 0);

  const record: TokenRecord = {
    runId: entry.runId,
    phase: PHASES.includes(entry.phase) ? entry.phase : "EXPLORATION",
    round: Number.isFinite(entry.round) ? entry.round : 0,
    agent: entry.agent,
    model: entry.model,
    provider: entry.provider,
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    totalTokens: inputTokens + outputTokens,
    estimated,
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    status: entry.status ?? "ok",
    at: Date.now(),
  };

  records.push(record);
  const s = stats;
  s.requests += 1;
  s.inputTokens += record.inputTokens;
  s.outputTokens += record.outputTokens;
  s.totalTokens += record.totalTokens;
  if (cached !== null) s.cachedInputTokens += cached;
  if (estimatedPortion > 0) s.estimatedTokens += estimatedPortion;
  const phase = s.byPhase[record.phase];
  phase.inputTokens += record.inputTokens;
  phase.outputTokens += record.outputTokens;
  phase.totalTokens += record.totalTokens;
  phase.requests += 1;
  s.rounds = records.filter((r) => r.agent === "main").length;
  if (!s.largestRequest || record.totalTokens > s.largestRequest.totalTokens) {
    s.largestRequest = { totalTokens: record.totalTokens, phase: record.phase, round: record.round };
  }
  s.updatedAt = record.at;
  return record;
}

/** Track the largest tool result seen this run (evidence sizing, not billing). */
export function recordToolResult(
  runId: string,
  tool: string,
  output: unknown
): { chars: number; estimatedTokens: number } {
  const { stats } = touch(runId);
  let chars = 0;
  try {
    chars = typeof output === "string" ? output.length : JSON.stringify(output)?.length ?? 0;
  } catch {
    chars = 0;
  }
  const estimated = estimateTokens(chars);
  if (!stats.largestToolResult || chars > stats.largestToolResult.chars) {
    stats.largestToolResult = { tool, chars, estimatedTokens: estimated };
  }
  stats.updatedAt = Date.now();
  return { chars, estimatedTokens: estimated };
}

export function recordBrowserAction(runId: string): void {
  touch(runId).stats.browserActions += 1;
}

export function getRunTokenStats(runId: string): RunTokenStats | null {
  const entry = runs.get(runId);
  return entry ? entry.stats : null;
}

export function getRunTokenRecords(runId: string): TokenRecord[] {
  return runs.get(runId)?.records ?? [];
}

/** Backward-compatible cumulative shape consumed by the existing UI meter. */
export function usageSnapshot(stats: RunTokenStats | null): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  if (!stats) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    totalTokens: stats.totalTokens,
  };
}

export function clearRunTokens(runId: string): void {
  runs.delete(runId);
}
