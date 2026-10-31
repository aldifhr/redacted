import {
  areaSignalsFor,
  looksLikeErrorPage,
  urlMatchesArea,
  type EvidenceEntry,
} from "./report";
import type { CoverageStatus, ExplorationTask } from "./task-state";

// Backend-authoritative coverage (audit phase 8). Statuses are computed
// from evidence, never from what the model claims. The LLM may suggest
// findings; this module validates them against what tools actually did.
//
//   VISITED             the area's URL/state was reached
//   INSPECTED           observations were collected there
//   PARTIALLY_VERIFIED  reached + inspected, but no passing assertion
//   VERIFIED            reached, inspected, AND a passing assertion
//   FAILED              a required behavior failed (failing assertion)
//   BLOCKED             an identifiable blocker (error page) stopped it
//   SKIPPED             intentionally excluded with a recorded reason

const VERIFY_TOOLS = new Set(["browser_snapshot", "browser_get_text", "test_assert"]);

export function entriesForArea(area: string, ledger: EvidenceEntry[]): EvidenceEntry[] {
  return ledger.filter(
    (e) =>
      urlMatchesArea(e.url, area) ||
      areaSignalsFor(e.selector, e.excerpt).includes(area.toLowerCase())
  );
}

/** Compute one area's status from its evidence entries. */
export function computeAreaStatus(area: string, entries: EvidenceEntry[]): CoverageStatus {
  if (!entries.length) return "NOT_STARTED";
  const blocked = entries.some(
    (e) => (e.excerpt ?? "").startsWith("[possible error page]") || looksLikeErrorPage(e.excerpt)
  );
  if (blocked && entries.every((e) => (e.excerpt ?? "").startsWith("[possible error page]"))) {
    return "BLOCKED";
  }
  const asserts = entries.filter((e) => e.tool === "test_assert");
  if (asserts.some((e) => e.pass === false)) return "FAILED";
  const inspected = entries.some((e) => VERIFY_TOOLS.has(e.tool));
  if (!inspected) return "VISITED";
  // VERIFIED requires a passing assertion tied to the area — a snapshot
  // alone can never verify (this is what let footer/cart/checkout be
  // marked Verified without evidence before).
  if (asserts.some((e) => e.pass === true)) return "VERIFIED";
  return "PARTIALLY_VERIFIED";
}

/** Recompute every task's status from the full ledger. */
export function refreshTaskStatuses(tasks: ExplorationTask[], ledger: EvidenceEntry[]): ExplorationTask[] {
  return tasks.map((task) => {
    const entries = entriesForArea(task.area, ledger);
    const status = computeAreaStatus(task.area, entries);
    const evidenceIds = entries
      .map((e) => (e as EvidenceEntry & { evidenceId?: string }).evidenceId)
      .filter((id): id is string => typeof id === "string");
    return {
      ...task,
      status,
      evidenceIds: evidenceIds.length ? evidenceIds : task.evidenceIds,
    };
  });
}

export type CoverageSummary = {
  requestedAreas: string[];
  visitedAreas: string[];
  coveredAreas: string[];
  areaStatuses: Record<string, CoverageStatus>;
  overall: "COMPLETE" | "PARTIAL" | "FAILED" | "BLOCKED";
};

/**
 * Overall run status. COMPLETE requires every requested area VERIFIED;
 * a token-limit stop can never be COMPLETE unless all work truly
 * finished (capped && incomplete → PARTIAL).
 */
export function summarizeCoverage(
  tasks: ExplorationTask[],
  opts: { capped?: boolean; stopReason?: string } = {}
): CoverageSummary {
  const areaStatuses: Record<string, CoverageStatus> = {};
  for (const t of tasks) areaStatuses[t.area] = t.status;
  const requestedAreas = tasks.map((t) => t.area);
  const coveredAreas = tasks.filter((t) => t.status === "VERIFIED").map((t) => t.area);
  const visitedAreas = tasks
    .filter((t) => t.status !== "NOT_STARTED" && t.status !== "SKIPPED")
    .map((t) => t.area);
  const anyFailed = tasks.some((t) => t.status === "FAILED");
  const allBlocked = tasks.length > 0 && tasks.every((t) => t.status === "BLOCKED");
  const allVerified = tasks.length > 0 && tasks.every((t) => t.status === "VERIFIED");
  let overall: CoverageSummary["overall"] = "PARTIAL";
  if (allVerified) overall = "COMPLETE";
  else if (allBlocked) overall = "BLOCKED";
  else if (anyFailed && coveredAreas.length === 0) overall = "FAILED";
  if (opts.capped && !allVerified) overall = overall === "COMPLETE" ? "PARTIAL" : overall;
  return { requestedAreas, visitedAreas, coveredAreas, areaStatuses, overall };
}
