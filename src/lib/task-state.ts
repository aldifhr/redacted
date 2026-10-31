import type { ExplorationScope } from "./exploration";

// Task-oriented execution state (audit phase 6) + backend-authoritative
// coverage statuses (audit phase 8). The orchestrator selects work from
// this structured state; the LLM never rediscovers completed tasks.

export type CoverageStatus =
  | "NOT_STARTED"
  | "VISITED"
  | "INSPECTED"
  | "PARTIALLY_VERIFIED"
  | "VERIFIED"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED";

export type ExplorationTask = {
  id: string;
  area: string;
  objective: string;
  preconditions: string[];
  requiredActions: string[];
  verificationCriteria: string[];
  dependencies: string[];
  status: CoverageStatus;
  evidenceIds: string[];
  blockedReason?: string;
};

/** Build one explicit task per requested area. */
export function buildTasks(scope: ExplorationScope): ExplorationTask[] {
  const areas = scope.areas.length ? scope.areas : ["primary flow"];
  const hasLogin = areas.some((a) => a.toLowerCase() === "login");
  return areas.map((area, i) => ({
    id: `task_${i + 1}_${area.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    area,
    objective: `Explore and verify the ${area} area of ${scope.site}.`,
    preconditions:
      hasLogin && area.toLowerCase() !== "login"
        ? ["login completed (authenticated session)"]
        : [],
    requiredActions: [
      `reach the ${area} page/state`,
      `inspect its interactive controls`,
      "assert key outcomes with test_assert",
    ],
    verificationCriteria: [
      `${area} reached with a browser observation`,
      `${area} controls inspected`,
      `at least one passing assertion tied to ${area}`,
    ],
    dependencies:
      hasLogin && area.toLowerCase() !== "login" ? ["login"] : [],
    status: "NOT_STARTED",
    evidenceIds: [],
  }));
}

const INCOMPLETE: CoverageStatus[] = [
  "NOT_STARTED",
  "VISITED",
  "INSPECTED",
  "PARTIALLY_VERIFIED",
];

export function isComplete(status: CoverageStatus): boolean {
  return status === "VERIFIED";
}

export function isIncomplete(status: CoverageStatus): boolean {
  return INCOMPLETE.includes(status);
}

/** First incomplete task whose dependencies are at least reachable. */
export function selectNextTask(tasks: ExplorationTask[]): ExplorationTask | null {
  const byArea = new Map(tasks.map((t) => [t.area.toLowerCase(), t]));
  for (const task of tasks) {
    if (!isIncomplete(task.status)) continue;
    const blocked = task.dependencies.some((dep) => {
      const dt = byArea.get(dep.toLowerCase());
      return dt ? dt.status === "NOT_STARTED" || dt.status === "BLOCKED" : false;
    });
    if (!blocked) return task;
  }
  // everything incomplete is dependency-blocked: return the first anyway
  return tasks.find((t) => isIncomplete(t.status)) ?? null;
}

export function pendingAreas(tasks: ExplorationTask[]): string[] {
  return tasks.filter((t) => isIncomplete(t.status)).map((t) => t.area);
}

export function completedAreas(tasks: ExplorationTask[]): string[] {
  return tasks.filter((t) => isComplete(t.status)).map((t) => t.area);
}

/** Compact task list for the execution prompt — no transcript re-reading. */
export function renderTaskState(tasks: ExplorationTask[], current: ExplorationTask | null): string {
  const lines = tasks.map(
    (t) =>
      `- [${t.status}] ${t.area}` +
      (t.evidenceIds.length ? ` (evidence: ${t.evidenceIds.join(", ")})` : "") +
      (t.blockedReason ? ` — blocked: ${t.blockedReason}` : "")
  );
  return [
    "# Task board (server-owned — do not redo completed tasks)",
    ...lines,
    current ? `Current task: ${current.area} — ${current.objective}` : "All tasks complete.",
  ].join("\n");
}
