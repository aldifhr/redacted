import type { ModelMessage } from "ai";
import type { ExplorationScope } from "./exploration";
import type { EvidenceRecord } from "./evidence-store";
import { evidenceRef } from "./evidence-store";

// Context management architecture (audit phase 3). Six separated layers,
// each built by a pure function so per-layer policies (windowing,
// deduplication, compaction — phases 4/5) can change without touching
// the agent loop.
//
//   A. SystemContext   — static instructions, role, tool rules, skills
//   B. TaskContext     — user request, objective, plan, criteria, status
//   C. ExplorationState — live URL/area, completed/pending/failed areas
//   D. WorkingContext  — bounded recent turns + current observation only
//   E. EvidenceStore   — full payloads on disk, referenced by id (never
//                        in the model context; see lib/evidence-store)
//   F. SummaryContext  — compact summaries of completed work, evidence
//                        IDs only, never raw payloads

// ── A. System context ──

export type SystemContext = {
  /** SOUL + SYSTEM_PROMPT + metadata + MEMORY + skills, built once per run. */
  instructions: string;
  /** Stable execution rules appended after the scope block. */
  rules: string;
  chars: number;
};

export function buildSystemContext(instructions: string, rules: string): SystemContext {
  return { instructions, rules, chars: instructions.length + rules.length };
}

// ── B. Task context ──

export type TaskContext = {
  userRequest: string;
  objective: string;
  plan: string[];
  acceptanceCriteria: string[];
  status: string;
};

export function buildTaskContext(input: {
  userRequest: string;
  areas: string[];
  completedAreas: string[];
}): TaskContext {
  const total = input.areas.length;
  const done = input.completedAreas.length;
  return {
    userRequest: input.userRequest,
    objective: total
      ? `Explore and verify every requested area: ${input.areas.join(", ")}.`
      : "Explore the current site and report testable areas.",
    plan: input.areas,
    acceptanceCriteria: input.areas.map(
      (area) => `${area}: reached, inspected, and key outcomes asserted with evidence`
    ),
    status: total ? `${done}/${total} areas verified` : "no explicit area scope",
  };
}

// ── C. Exploration state ──

export type ExplorationState = {
  currentUrl: string;
  currentArea: string;
  completedAreas: string[];
  pendingAreas: string[];
  failedAreas: string[];
  lastAction: string;
  browserActions: number;
};

export function buildExplorationState(input: {
  currentUrl: string;
  areas: string[];
  completedAreas: string[];
  failedAreas?: string[];
  lastAction: string;
  browserActions: number;
}): ExplorationState {
  const completed = input.completedAreas;
  return {
    currentUrl: input.currentUrl,
    currentArea: input.areas.find((a) => !completed.includes(a)) ?? input.areas[0] ?? "",
    completedAreas: completed,
    pendingAreas: input.areas.filter((a) => !completed.includes(a)),
    failedAreas: input.failedAreas ?? [],
    lastAction: input.lastAction,
    browserActions: input.browserActions,
  };
}

// ── D. Working context ──

export type WorkingContext = {
  /** Bounded window of raw recent turns (policy owned by phase 4). */
  recentTurns: ModelMessage[];
  /** Latest observation, already compacted to what the decision needs. */
  currentObservation: string;
  turnCount: number;
};

export function buildWorkingContext(input: {
  recentTurns: ModelMessage[];
  currentObservation: string;
  maxTurns?: number;
}): WorkingContext {
  const max = input.maxTurns && input.maxTurns > 0 ? input.maxTurns : Number.POSITIVE_INFINITY;
  const turns = Number.isFinite(max) ? input.recentTurns.slice(-max) : input.recentTurns;
  return {
    recentTurns: turns,
    currentObservation: input.currentObservation,
    turnCount: input.recentTurns.length,
  };
}

// ── F. Summary context ──

export type SummaryContext = {
  task: string;
  currentUrl: string;
  completedAreas: { area: string; status: string; evidenceIds: string[] }[];
  pendingAreas: string[];
  importantObservations: string[];
  failedAttempts: string[];
  nextTask: string;
  constraints: string[];
  lastCompaction: string;
};

export function buildSummaryContext(input: Partial<SummaryContext> & { task: string }): SummaryContext {
  return {
    task: input.task,
    currentUrl: input.currentUrl ?? "",
    completedAreas: input.completedAreas ?? [],
    pendingAreas: input.pendingAreas ?? [],
    importantObservations: input.importantObservations ?? [],
    failedAttempts: input.failedAttempts ?? [],
    nextTask: input.nextTask ?? "",
    constraints: input.constraints ?? [],
    lastCompaction: input.lastCompaction ?? new Date().toISOString(),
  };
}

/** Compact render: evidence IDs only — never raw payloads. */
export function renderSummary(summary: SummaryContext): string {
  return JSON.stringify(summary);
}

// ── E. Evidence references ──

/** Compact reference lines for a set of evidence records. */
export function renderEvidenceRefs(records: EvidenceRecord[]): string {
  return records.map(evidenceRef).join("\n");
}

// ── Composition ──

const EXPLORATION_RULES =
  "Explore every requested area, including currentArea, before declaring the exploration complete. " +
  "An area is covered only after a browser tool result visibly reaches that area's URL/state; " +
  "writing cases or inferring known locators does not count as exploration. " +
  "Do not claim a flow was completed if its page was not reached and verified. " +
  "Save incremental artifacts as each area is finished. " +
  "Execute at most one tool call per model round. " +
  "Do not save the same artifact repeatedly unless adding genuinely new cases; " +
  "after an artifact is saved, continue the browser flow.";

/**
 * System text for one run: static instructions + scope block + rules.
 * Same content the agent loop built inline before phase 3, now composed
 * from typed layers so each section can evolve independently.
 */
export function composeExecutionPrompt(input: {
  systemPrompt: string;
  scope: ExplorationScope;
  completedAreas: string[];
  currentArea: string;
  nextArea: string;
}): string {
  const { systemPrompt, scope, completedAreas, currentArea, nextArea } = input;
  const budgetSentence = Number.isFinite(scope.maxActions)
    ? `Use at most ${scope.maxActions} browser actions.`
    : "There is no browser-action budget; continue through all requested areas until coverage is complete or a real blocker occurs.";
  return (
    `${systemPrompt}\n\n---\n# Current exploration scope\n` +
    `${JSON.stringify({ ...scope, completedAreas, currentArea, nextArea }, null, 2)}\n` +
    `${EXPLORATION_RULES} ${budgetSentence}`
  );
}

/**
 * Deterministic assembly of the model messages for one round.
 * Order: task/state opening turn, then the working window. The system
 * text travels separately (SDK `system` param).
 */
export function composeRoundMessages(input: {
  task: TaskContext;
  state: ExplorationState;
  working: WorkingContext;
}): ModelMessage[] {
  const opening: ModelMessage = {
    role: "user",
    content:
      `Task: ${input.task.userRequest}\n` +
      `Objective: ${input.task.objective}\n` +
      `Status: ${input.task.status}\n` +
      `State: url=${input.state.currentUrl || "(none yet)"} area=${input.state.currentArea || "(none)"} ` +
      `completed=[${input.state.completedAreas.join(", ")}] ` +
      `pending=[${input.state.pendingAreas.join(", ")}] ` +
      `lastAction=${input.state.lastAction || "(none)"} ` +
      `browserActions=${input.state.browserActions}`,
  };
  return [opening, ...input.working.recentTurns];
}
