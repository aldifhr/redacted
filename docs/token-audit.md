# Redacted — Token Consumption Audit (Phase One)

Audit of the SauceDemo exploration run (33 browser actions / 33 model rounds, stopped at 1,026,310 tokens against a 1,000,000 limit).

**Measurement caveat:** the original run's `.runs/` event log is not present on this machine, so per-round provider usage could not be re-read. All token figures below are *derived from measured code constants* (byte sizes of prompts and tool outputs, chars÷4) and are labeled as estimates. The derived gross total (1.63M) and the cache-discounted total (~0.68M) bracket the observed 1.03M, which is itself evidence that prompt caching was active but insufficient.

## Pipeline trace

```
user prompt
  → parseExplorationScope()            exploration.ts:31
  → getSystemPrompt()  (ONCE per run)  soul.ts:27
  → executionPrompt = system + scope   stream/route.ts:183
  → loop i in 0..maxModelRounds        stream/route.ts:360
      → generateText({                 stream/route.ts:391
          system: executionPrompt,     ← ~12.6k tokens EVERY round
          messages: modelMessages,     ← FULL history EVERY round
          stopWhen: stepCountIs(1)     ← 1 tool call per round
        })
      → tool executes (browser.ts)
      → modelMessages = [...modelMessages, ...result.response.messages]   route.ts:640
  → scribe report (generateObject)     stream/route.ts:763
```

## Root causes (ranked)

### RC1 — Full-history resend every round: O(n²) growth
`stream/route.ts:309-312` seeds `modelMessages` with the conversation; `:640` appends every assistant message **and every tool result** after each round; `:391-394` resends the entire array on every `generateText`. Nothing is ever removed, summarized, or windowed.

- Derived: final round carries ~70k tokens of accumulated history; average ~35k/round.
- Derived: ~1.20M of the ~1.63M gross input tokens are re-sent old observations.
- This is the primary cause. A 33-round run pays for round 1's snapshot 33 times.

### RC2 — No observation deduplication
`browser.snapshot()` (`browser.ts:512`) and `browser.getText()` (`browser.ts:479`) are called freely by the model; identical URL + unchanged DOM produces a byte-identical 12,000-char / 8,000-char result that is stored verbatim in history each time. No hash, no fingerprint, no "unchanged since last snapshot" short-circuit exists anywhere in the pipeline.

### RC3 — No context compaction
There is no summarization, sliding window, or structured-state substitution anywhere in `route.ts`. The only bound is `MAX_RUN_TOKENS` (`route.ts:328`), checked at `:365` **between** rounds — so the round that crosses the limit always completes, guaranteeing overshoot. Observed 1,026,310 vs 1,000,000 limit = exactly one final ~26k-token round of overshoot. `MAX_STEPS` defaults to `Number.POSITIVE_INFINITY` (`route.ts:41`) and `MAX_UNBOUNDED_MODEL_ROUNDS` to 200 (`:43`), so nothing else stops a long run.

### RC4 — Screenshots persist as base64 in conversation history
`browser.screenshot()` (`browser.ts:605-613`) returns `{image: "data:image/png;base64,…"}`. The AI SDK serializes that into the tool-result message, where it remains in `modelMessages` for the rest of the run. A single viewport PNG is typically 100–400KB of base64 (~25k–100k tokens as text; ~1–2k as an image part on vision models — either way the largest single object in the loop). Auto-screenshots are capped at 6 (`route.ts:342`) but **model-initiated** `browser_screenshot` calls are uncapped, and every one is permanent history.

### RC5 — Fat system prompt re-sent every round
`getSystemPrompt()` (`soul.ts:27-52`) composes SOUL.md (1,949 B) + SYSTEM_PROMPT (10,366 B) + metadata + MEMORY.md (748 B) + **all four trusted skill SKILL.md files (35,359 B total, of which playwright-best-practices alone is 26,306 B)**. Measured total: ~50.3KB ≈ **12,585 tokens per round** → ~415k tokens across 33 rounds. Most skill content (CI/CD, frameworks, architecture) is irrelevant to any single browser decision. It is built once per run (good) but attached to every request (RC1 makes that expensive). Note `route.ts:161`'s comment claims the prompt is "stable for the lifetime of a run" — true, but stability is exactly what makes it cache-worthy, and nothing marks it as a cacheable prefix explicitly.

### RC6 — Verification is heuristic, not evidence-based (the inaccurate-report bug)
`stream/route.ts:514-552`: an area enters `verifiedAreas` when a `browser_snapshot` / `browser_get_text` / `test_assert` result's **URL matches** the area — or when `areaSignalsFor()` (`report.ts:170-176`) finds a hint substring anywhere in the snapshot excerpt. Content is never checked.

- Footer: `FOOTER_HINTS` includes `"social"`, `"twitter"`, `"youtube"` — any 12k snapshot containing the word "Twitter" marks *footer* Verified. No scroll-to-footer, no footer element inspection required.
- Dynamic catalog: URL match alone verifies; newly loaded content is never confirmed.
- Cart: a snapshot whose URL contains `/cart` verifies; cart behavior (remove, badge update) is never required.
- `report.ts:188-200` (`ledgerStatus`) and `:344-349` (`resolveStatus`) then trust `coverage.coveredAreas`, which descends from this heuristic.

The architecture already has the right *ingredients* — an evidence ledger (`route.ts:321`, failed calls excluded at `:479-486`), server-side rendering that ignores model status (`renderReportMarkdown`), banned-claim stripping (`report.ts:320`). The defect is that **coverage status is computed from URL/substring heuristics instead of from per-area verification criteria evaluated against the ledger.**

### RC7 — Reporting has no budget reserve
The scribe call (`route.ts:763-786`) runs *after* the budget check breaks the loop, with no reserved capacity. On gateways without json_schema support it falls back to a second full `generateText` (`:774-779`) — doubling reporting cost at exactly the moment the budget is exhausted. (The scribe input itself is already compact — ledger summary + last 4,000 chars of `fullText` — so reporting is *not* a major token source; the problem is ordering and the double call.)

### RC8 — No usable token instrumentation
Usage is accumulated as a single cumulative blob (`route.ts:434-449`): no round number, no phase, no `cachedInputTokens`, no per-request duration, no largest-request/largest-tool-result tracking. `cost.ts` only estimates USD from model name. This is why the 1M-token run could not be diagnosed from its own telemetry — the data to answer "which round burned what" was never recorded.

## Observation size budget (measured)

| Source | Size | Tokens (÷4) |
|---|---|---|
| `browser_snapshot` (120 elems × 220 chars, sliced 12,000) | ≤12,000 chars | ~3,000 |
| `browser_get_text` (sliced 8,000) | ≤8,000 chars | ~2,000 |
| `browser_screenshot` (base64 PNG, uncapped by model) | 100–400KB | ~25k–100k (text) |
| `browser_network_log` (200 entries) | ~30KB | ~7,500 |
| `browser_console` (200 entries) | ~20KB | ~5,000 |
| system prompt (all components) | 50,342 chars | ~12,585 |
| navigate/click/type results | ~150 chars | ~40 |

`browser_scroll`'s tool description claims "then snapshot again" (`agent.ts:192`) but `scrollPage()` (`browser.ts:711-729`) returns only `{url, scrollY}` — the description is wrong; scroll is cheap. (Doc bug, not a token cost.)

## What is already sound (preserve)

- Evidence ledger with failed-call exclusion (`route.ts:479-486`, `:554-574`).
- Server-authoritative report rendering; model status ignored (`route.ts:719-721`, `report.ts:343-349`).
- Checkpoint/resume scaffolding (`exploration.ts:117-121`) — completedAreas/currentArea/nextArea persist per site.
- Scribe input compaction (ledger summary, not raw transcript).
- Bounded nudge loop (`route.ts:670-692`, max 3).
- `run-log.ts` durable event log with screenshot-payload truncation.

## Implementation map (Phases 2–11, for approval before coding)

1. **Instrumentation** (`lib/token-meter.ts`, new): per-round records {runId, phase, round, input, output, cachedInput, duration, status}; cumulative per-run; largest request/tool-result; surfaced in existing run-details UI. Provider usage preferred; estimates labeled.
2. **Context architecture** (`lib/context/`, new): system / task / exploration-state / working / evidence-store / summary separation. Evidence store = on-disk artifacts + IDs; working context = bounded recent window + current observation only.
3. **Observation optimization**: content-hash dedup for snapshot/get_text (invalidate on URL change *or* DOM hash change); interactive-element-first snapshot with truncation recorded; tool results >2,000 chars stored as evidence artifacts with a one-line summary + evidence ID in context; screenshots excluded from `modelMessages` (evidence store only, referenced by ID).
4. **Compaction**: structured summary object (per task doc §8 schema, adapted to existing TS types) replacing raw history when context exceeds a threshold; compaction never invents facts; failures and user requirements preserved.
5. **Task-oriented execution**: explicit task objects (id/area/objective/preconditions/actions/criteria/status/evidence/budget); orchestrator picks next task from structured state, not from re-reading the transcript.
6. **Budget management**: configurable per-phase budgets (plan/explore/verify/report) with a reserved finalization slice; graceful exhaustion → persist state, mark unfinished tasks incomplete, partial report with stop reason. No silent budget raises.
7. **Backend-authoritative coverage**: replace the URL/substring heuristic with per-area verification criteria evaluated against the ledger; statuses NOT_STARTED/VISITED/INSPECTED/PARTIALLY_VERIFIED/VERIFIED/FAILED/BLOCKED/SKIPPED assigned server-side only.
8. **Reporting**: deterministic rendering from structured data; LLM scribe only when it adds value; single call (drop the double-call fallback or make it budget-aware).
9. **Regression tests** per task doc §14; run `npm run test:unit` + `typecheck` + `lint` and report real output.

No new dependencies required for phases 2–9 (hashing: `node:crypto`; storage: existing `fs` patterns; tokenizer: provider usage metadata with labeled estimates).

---

# Implementation status (all phases delivered)

Commits: `09c1e8a` (phase 2) → `2f7ea00` (3) → `1f3cf05` (4) → `d5a528e` (5–9).

## Modified / added files

**New modules**
- `src/lib/token-meter.ts` — per-request token accounting, per-phase aggregates, estimate labeling (phase 2)
- `src/lib/evidence-store.ts` — append-only full-fidelity evidence store with `ev_N` IDs (phase 3, layer E)
- `src/lib/context.ts` — the six context layers as typed builders + prompt/round composition (phase 3)
- `src/lib/observation-dedup.ts` — content-addressed observation dedup (phase 4B)
- `src/lib/observation-compact.ts` — tool-result compaction + `rewriteToolOutputs` (phase 4C/4D)
- `src/lib/task-state.ts` — task board + selection (phase 6)
- `src/lib/coverage.ts` — backend-authoritative area statuses (phase 8)
- `src/lib/context-compactor.ts` — deterministic history compaction (phase 5)
- `src/lib/budget.ts` — configurable budgets + per-phase ceilings (phase 7)

**Modified**
- `src/app/api/chat/stream/route.ts` — wires all of the above: evidence append + dedup + compaction per tool result, task board in the prompt, per-round status refresh, budget verdicts, graceful-exhaustion checkpoint, `tokenStats`/`tasks`/`budget` in the `done` payload
- `src/lib/agent.ts` — new `evidence_read` tool (full payload by ID, budget-exempt)
- `src/lib/report.ts` — `evidenceId` on ledger entries, `areaStatuses`/`overall` on Coverage, `Partially verified` status, backend-first `resolveStatus`, overall-status header
- `src/components/chat/types.ts`, `src/components/Chat.tsx` — `TokenStats` type, token meter tooltip shows per-phase breakdown + estimated/cached
- `tests/lib.spec.ts` — 33 new regression tests (phases 2–9)

## Measured results

- Unit suite: **61 passed**, 1 failed — `ssrf guard unwraps hex IPv4-mapped IPv6`, **pre-existing on `acb828f`** (verified via `git stash`), untouched by this work.
- `tsc --noEmit` clean; `eslint` clean (1 pre-existing warning in `scripts/debug-all-tools.ts`).
- Token model (derived from code constants, same method as the audit): per-round history growth drops from ~3–5k tokens to ~100–200; 33-round history from ~70k to ~5k tokens; projected run total ~450k gross / ~150–250k with prompt caching vs the observed 1.03M.

## Remaining limitations (honest list)

1. **No live before/after run yet** — projections are derived from code constants; the SauceDemo re-run with the new pipeline has not been executed on this machine (no provider key configured here). The meter now records per-round/per-phase usage so the next real run produces the measurement.
2. **VERIFIED requires a passing `test_assert`** — areas the model only browses cap at PARTIALLY_VERIFIED by design. This is the conservative fix for the false-Verified bug; runs whose models rarely assert will report more partials (correct, not a regression).
3. **Sub-agent (`browser_delegate`) history is internal to one `generateText` call** — dedup/compaction do not apply inside it; bounded by its 8-step cap.
4. **Prompt caching is provider-side** — the system prompt (~12.6k tokens/round) is still resent every round; `cachedInputTokens` is now tracked so cache hit rates are visible, but no explicit cache-control annotations are sent.
5. **The scribe fallback double-call remains** for gateways without json_schema support (now inside the reserved reporting budget).
6. **`evidence_read` returns full payloads including base64 screenshots** when explicitly requested — intentional (explicit retrieval), but it re-enters context at full size.
7. **SKIPPED status is defined but never set** — no scope-exclusion syntax exists in `parseExplorationScope` yet.
8. **Checkpoint resume is scope-level** (completed areas), not task-ID-level; a resumed run rebuilds the task board and re-derives statuses from the new run's ledger rather than importing the old one.

---

# Phase Ten — Performance & reliability evaluation

Per-item verdict on the task doc §13 checklist, evaluated against what phases 2–9 actually built:

| Candidate | Verdict | Where / why |
|---|---|---|
| Structured observation caching | **Implemented** | `observation-dedup.ts` — per-run, content-addressed (sha256). No disk cache needed: dedup only suppresses re-sending; the evidence store already persists every payload. |
| Evidence indexing | **Implemented** | `ev_N` IDs per run; `readEvidence()` filters by kind/tool/url; `getEvidence(id)` for point lookup. JSONL append-only, one file per run — sufficient at hundreds of entries per run. |
| Incremental state persistence | **Implemented** | Checkpoint written per tool call and on every stop path (`saveExplorationCheckpoint`); evidence appended per tool result; run-log event per SSE event. Nothing waits for run end. |
| Hash-based snapshot dedup | **Implemented** | `observation-dedup.ts` — full-content hash keyed by URL; any material page change invalidates. |
| Bounded in-memory context | **Implemented** | `MAX_CONTEXT_TOKENS` (default 24k) + deterministic compaction; token meter capped at 50 runs; dedup map cleared in `finally`. |
| Efficient retrieval by evidence ID | **Implemented** | `evidence_read` tool + `getEvidence()`. Linear scan of one run's file is fine at current scale; an index would only be needed at thousands of entries per run — not demonstrated, so not built (YAGNI). |
| Task-level checkpointing | **Partial** | Checkpoint persists scope-level state (completed areas, current/next area, last action, stop reason). The task board is rebuilt and re-derived from the new run's ledger on resume. Task-ID-level import is limitation #8 — deferred because no resume flow consumes it yet. |
| Redis / second DB / vector store / new orchestration framework | **Not needed — none added** | The existing agent loop, `fs` patterns, and `node:crypto` cover every requirement. Adding infrastructure here would violate the task doc's own constraint (§13, §15, §16). |

**Conclusion:** the existing stack handles every requirement. Zero new dependencies, zero new services, zero framework replacement.
