import type { ModelMessage } from "ai";
import type { EvidenceEntry } from "./report";
import {
  buildSummaryContext,
  renderSummary,
  type SummaryContext,
} from "./context";
import {
  pendingAreas,
  selectNextTask,
  type ExplorationTask,
} from "./task-state";

// Context compaction (audit phase 5). Deterministic: the summary is
// built from the evidence ledger and task board — structured facts the
// backend recorded — never from an LLM re-reading the transcript, so it
// cannot invent facts. Verified vs pending is preserved by construction,
// failures and user requirements survive, and evidence IDs (not raw
// payloads) are carried forward.

export type CompactionResult = {
  compacted: boolean;
  messages: ModelMessage[];
  summary: SummaryContext | null;
  droppedTurns: number;
};

/** Rough token estimate for a message array (chars ÷ 4). */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    try {
      chars += typeof m.content === "string" ? m.content.length : (JSON.stringify(m.content)?.length ?? 0);
    } catch {
      /* ignore */
    }
  }
  return Math.ceil(chars / 4);
}

export function shouldCompact(messages: ModelMessage[], maxContextTokens: number): boolean {
  return estimateMessagesTokens(messages) > maxContextTokens;
}

/**
 * Compact history: keep the original user request (first user message)
 * plus the most recent `maxRecentTurns` turns; everything between is
 * replaced by one structured summary message built from the ledger and
 * task board.
 */
export function compactHistory(input: {
  messages: ModelMessage[];
  tasks: ExplorationTask[];
  ledger: EvidenceEntry[];
  userRequest: string;
  currentUrl: string;
  maxRecentTurns: number;
}): CompactionResult {
  const { messages, tasks, ledger, userRequest, currentUrl, maxRecentTurns } = input;

  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx < 0 || messages.length <= maxRecentTurns + 1) {
    return { compacted: false, messages, summary: null, droppedTurns: 0 };
  }

  const head = messages.slice(0, firstUserIdx + 1);
  const tailStart = Math.max(firstUserIdx + 1, messages.length - maxRecentTurns);
  const tail = messages.slice(tailStart);
  const dropped = messages.length - head.length - tail.length;
  if (dropped <= 0) {
    return { compacted: false, messages, summary: null, droppedTurns: 0 };
  }

  const failedAttempts = ledger
    .filter((e) => e.tool === "test_assert" && e.pass === false)
    .map((e) => `assert failed: ${e.selector || e.url}${e.excerpt ? ` — ${e.excerpt.slice(0, 120)}` : ""}`);
  const errorPages = ledger
    .filter((e) => (e.excerpt ?? "").startsWith("[possible error page]"))
    .map((e) => `error page at ${e.url}`);
  const observations = ledger
    .filter((e) => e.tool === "browser_snapshot" || e.tool === "browser_get_text")
    .map((e) => `observed ${e.url}${e.selector ? ` [${e.selector}]` : ""}`);

  const summary = buildSummaryContext({
    task: userRequest,
    currentUrl,
    completedAreas: tasks
      .filter((t) => t.status === "VERIFIED" || t.status === "PARTIALLY_VERIFIED")
      .map((t) => ({
        area: t.area,
        status: t.status,
        evidenceIds: t.evidenceIds,
      })),
    pendingAreas: pendingAreas(tasks),
    importantObservations: [...new Set(observations)].slice(-20),
    failedAttempts: [...new Set([...failedAttempts, ...errorPages])].slice(-10),
    nextTask: selectNextTask(tasks)?.area ?? "",
    constraints: [
      "verified areas must not be re-explored",
      "pending areas still need a passing assertion before they count as verified",
    ],
  });

  const summaryMessage: ModelMessage = {
    role: "user",
    content:
      `[Context compacted — ${dropped} earlier turns replaced by this server-built summary. ` +
      `It is derived from recorded evidence, not from memory. Raw payloads remain in the ` +
      `evidence store; retrieve them with evidence_read when needed.]\n${renderSummary(summary)}`,
  };

  return {
    compacted: true,
    messages: [...head, summaryMessage, ...tail],
    summary,
    droppedTurns: dropped,
  };
}
