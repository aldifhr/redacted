import type { TokenPhase } from "./token-meter";

// Token budget management (audit phase 7). Configurable defaults via
// env; nothing hardcoded at call sites. Per-phase shares of the total
// run budget guarantee that reporting always keeps reserved capacity —
// exploration cannot eat the finalization slice.

export type Budgets = {
  maxRunTokens: number;
  maxInputTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxModelRounds: number;
  maxBrowserActions: number;
  maxRunDurationMs: number;
  maxContextTokens: number;
  phaseShares: Record<Exclude<TokenPhase, "PLANNING">, number>;
};

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadBudgets(env: Record<string, string | undefined> = process.env): Budgets {
  const maxRunTokens = num(env.MAX_RUN_TOKENS, 1_000_000);
  return {
    maxRunTokens,
    maxInputTokensPerRequest: num(env.MAX_INPUT_TOKENS_PER_REQUEST, 200_000),
    maxOutputTokensPerRequest: num(env.MAX_OUTPUT_TOKENS_PER_REQUEST, 16_000),
    maxModelRounds: num(env.MAX_MODEL_ROUNDS, 200),
    maxBrowserActions: num(env.MAX_AGENT_STEPS, Number.POSITIVE_INFINITY),
    maxRunDurationMs: num(env.MAX_RUN_DURATION_MS, 270_000),
    maxContextTokens: num(env.MAX_CONTEXT_TOKENS, 24_000),
    phaseShares: {
      EXPLORATION: 0.7,
      VERIFICATION: 0.15,
      REPORTING: 0.15,
    },
  };
}

/** Token ceiling for one phase (share of the total run budget). */
export function phaseBudget(budgets: Budgets, phase: Exclude<TokenPhase, "PLANNING">): number {
  return Math.floor(budgets.maxRunTokens * budgets.phaseShares[phase]);
}

export type BudgetVerdict = {
  exceeded: boolean;
  reason?: string;
  phase?: Exclude<TokenPhase, "PLANNING">;
};

/**
 * Evaluate budgets before starting another model round. Per-phase
 * ceilings are checked first so a long exploration stops with room
 * left for verification and the final report.
 */
export function evaluateBudget(input: {
  budgets: Budgets;
  phaseTokens: Record<string, number>;
  totalTokens: number;
  modelRounds: number;
  browserActions: number;
  elapsedMs: number;
}): BudgetVerdict {
  const { budgets, phaseTokens, totalTokens, modelRounds, browserActions, elapsedMs } = input;
  if (budgets.maxRunTokens > 0 && totalTokens >= budgets.maxRunTokens) {
    return { exceeded: true, reason: "total run token budget", phase: "REPORTING" };
  }
  for (const phase of ["EXPLORATION", "VERIFICATION", "REPORTING"] as const) {
    const used = phaseTokens[phase] ?? 0;
    const cap = phaseBudget(budgets, phase);
    if (cap > 0 && used >= cap) {
      return { exceeded: true, reason: `${phase.toLowerCase()} phase token budget`, phase };
    }
  }
  if (Number.isFinite(budgets.maxModelRounds) && modelRounds >= budgets.maxModelRounds) {
    return { exceeded: true, reason: "model round budget" };
  }
  if (Number.isFinite(budgets.maxBrowserActions) && browserActions >= budgets.maxBrowserActions) {
    return { exceeded: true, reason: "browser action budget" };
  }
  if (budgets.maxRunDurationMs > 0 && elapsedMs >= budgets.maxRunDurationMs) {
    return { exceeded: true, reason: "run duration budget" };
  }
  return { exceeded: false };
}
