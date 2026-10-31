import { NextRequest } from "next/server";
import { z } from "zod";
import { generateText, generateObject, stepCountIs, type ModelMessage } from "ai";
import { getModel, PROVIDERS } from "@/lib/providers";
import { resolveKey } from "@/lib/key-vault";
import { withSpan } from "@/lib/telemetry";
import {
  getBrowserTools,
  statusLabel,
} from "@/lib/agent";
import { getSystemPrompt } from "@/lib/soul";
import * as browser from "@/lib/browser";
import {
  createRun,
  cancelRun,
  isCancelled,
  endRun,
  RUN_CANCELLED,
} from "@/lib/runs";
import { createApproval, isAlwaysAllowed, rejectRunApprovals } from "@/lib/approvals";
import { loadInstalledSkillsSync } from "@/lib/skills";
import { assertPublicTarget } from "@/lib/ssrf";
import { flushLogs } from "@/lib/tool-logs";
import { appendEvidence, type EvidenceKind } from "@/lib/evidence-store";
import { checkDuplicate, clearObservations, rememberObservation } from "@/lib/observation-dedup";
import { compactToolResult, duplicateMarker, rewriteToolOutputs } from "@/lib/observation-compact";
import { composeExecutionPrompt } from "@/lib/context";
import { buildTasks, completedAreas as completedTaskAreas, renderTaskState, selectNextTask, type ExplorationTask } from "@/lib/task-state";
import { refreshTaskStatuses, summarizeCoverage } from "@/lib/coverage";
import { compactHistory, shouldCompact } from "@/lib/context-compactor";
import { evaluateBudget, loadBudgets, type Budgets } from "@/lib/budget";
import { finishRunLog, logRunEvent, startRunLog } from "@/lib/run-log";
import {
  clearRunTokens,
  getRunTokenStats,
  recordBrowserAction,
  recordToolResult,
  recordTokenUsage,
  usageSnapshot,
  type TokenPhase,
  type TokenUsageInput,
} from "@/lib/token-meter";
import { parseExplorationScope, readExplorationCheckpoint, readLatestCheckpoint, saveExplorationCheckpoint } from "@/lib/exploration";
import {
  ReportDataSchema,
  looksLikeErrorPage,
  renderFallbackReport,
  renderReportMarkdown,
  type EvidenceEntry,
  type TestRunSummary,
} from "@/lib/report";
export const maxDuration = 300;
// No action cap by default. Set MAX_AGENT_STEPS or mention a limit in the
// request when a bounded chunk is desired; cancellation and step timeouts
// remain the backstops for an intentionally open-ended exploration.
const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS) || Number.POSITIVE_INFINITY;
// Backstop when no action budget is set: the model-round loop must still end.
const MAX_UNBOUNDED_MODEL_ROUNDS = Number(process.env.MAX_MODEL_ROUNDS) || 200;

function phaseFor(toolName?: string): string {
  if (!toolName) return "Explore";
  if (toolName.startsWith("test_")) return toolName === "test_run" ? "Testing" : "Artifacts";
  if (toolName.startsWith("memory_")) return "Memory";
  return "Explore";
}

function thinkingFor(toolName?: string, input?: unknown) {  const values = typeof input === "object" && input ? input as Record<string, unknown> : {};
  const target = typeof values.url === "string" ? ` ${values.url}` : " the current target";
  const selector = typeof values.selector === "string" ? ` ${values.selector}` : " the discovered element";
  switch (toolName) {
    case "browser_navigate": return `Opening${target} to start the test flow.`;
    case "browser_snapshot": return "Inspecting the page structure to find stable elements and locators.";
    case "browser_get_text": return "Checking visible text to validate the page state.";
    case "browser_click": return `Testing a click on${selector} to observe state or navigation changes.`;
    case "browser_type": return `Filling${selector} to continue the test scenario.`;
    case "browser_screenshot": return "Capturing visual evidence for the report.";
    case "browser_go_back": return "Going back one page to verify the previous navigation path.";
    case "browser_close": return "Closing the browser after the test step is complete.";
    case "browser_network_log": return "Logging network requests to debug the API layer.";
    case "browser_console": return "Reading console errors for the bug report.";
    case "browser_select": return "Selecting a dropdown option to continue the flow.";
    case "browser_wait": return "Waiting for the expected content to appear.";
    case "browser_storage": return "Inspecting storage for session state.";
    case "browser_cookies": return "Checking cookies for session state.";
    case "browser_upload": return "Uploading a file into the form.";
    case "browser_press": return "Pressing a key to continue the flow.";
    case "browser_hover": return "Hovering to reveal hidden content.";
    case "browser_drag": return "Dragging an element to its target.";
    case "browser_dialog": return "Reading a dialog message.";
    case "browser_tabs": return "Listing open tabs to follow the popup.";
    case "browser_tab_select": return "Switching to the new tab.";
    case "browser_tab_close": return "Closing the extra tab.";
    case "browser_downloads": return "Verifying the downloaded file.";
    case "browser_scroll": return "Scrolling the page to reveal content below the fold.";
    case "test_assert": return "Running a deterministic assertion to verify the expected outcome.";
    default: return "Choosing the next QA action from the latest observation.";
  }
}

function isBrowserAction(toolName: string) {
  return toolName.startsWith("browser_") || toolName === "test_assert";
}

function isArtifactAction(toolName: string) {
  return ["test_plan", "test_plan_document", "test_save", "test_run", "test_record"].includes(toolName);
}

const StreamBodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(50_000) }))
    .min(1)
    .max(100),
  provider: z.enum(["openai", "anthropic"]).optional().default("openai"),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(500).optional().default(""),
  baseUrl: z.string().max(500).optional().default(""),
  sessionId: z.string().max(100).optional().default(""),
});

// POST /api/chat/stream — SSE. Event:
//   status { label }   → tahap kerja agent (real-time, dari tool yang dieksekusi)
//   done   { text, toolCalls, screenshots, usage, model, provider }
//   error  { error }
export async function POST(req: NextRequest) {
  // No rate limiting on this route (removed per owner request): no guardApi
  // quota, no concurrency slots. Every validated request starts a stream.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const pre = StreamBodySchema.safeParse(rawBody);
  if (!pre.success) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  if (pre.data.baseUrl.trim()) {
    if (pre.data.baseUrl.trim().length > 500) {
      return Response.json({ error: "base URL is too long" }, { status: 400 });
    }
    try {
      await assertPublicTarget(pre.data.baseUrl.trim(), { allowLocal: true });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "invalid base URL" },
        { status: 400 }
      );
    }
  }
  return handleStream(req, pre.data);
}

async function handleStream(
  req: NextRequest,
  body: {
    messages: { role: "user" | "assistant"; content: string }[];
    provider: "openai" | "anthropic";
    model?: string;
    apiKey: string;
    baseUrl: string;
    sessionId: string;
  }
) {
  const {
    messages,
    provider = "openai",
    model,
    apiKey = "",
    baseUrl = "",
    sessionId = "",
  } = body;

  const chosenModel = model || PROVIDERS[provider].models[0];
  // The prompt is stable for the lifetime of a run. Rebuilding it per tool
  // step rereads MEMORY.md and every approved skill unnecessarily.
  const systemPrompt = getSystemPrompt({ provider, model: chosenModel, baseUrl });
  const latestUserPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  let scope = parseExplorationScope(latestUserPrompt);
  // A bare "continue" carries no URL, so scope.site is the "current site"
  // placeholder whose checkpoint (if any) is useless. Fall back to the newest
  // real-site checkpoint so resumption keeps its completed areas; warn loudly
  // when nothing is found instead of silently resetting the scope.
  let previousCheckpoint = scope.continue ? await readExplorationCheckpoint(scope.site) : null;
  let scopeWarning = "";
  if (scope.continue && !previousCheckpoint && scope.site === "current site") {
    previousCheckpoint = await readLatestCheckpoint();
    if (!previousCheckpoint) {
      scopeWarning = "No prior checkpoint found — starting a fresh scope. Name the site URL or areas to continue precisely.";
    } else if (previousCheckpoint.areas?.length) {
      // Adopt the checkpoint's scope: a bare "continue" means "resume that
      // run", so its requested areas (not ["primary flow"]) define coverage.
      scope = { ...scope, site: previousCheckpoint.site, areas: [...previousCheckpoint.areas] };
    }
  }
  let completedAreas = previousCheckpoint?.completedAreas ?? [];
  const currentArea = scope.areas.find((area) => !completedAreas.includes(area)) ?? scope.areas[0];
  const nextArea = scope.areas.find((area) => area !== currentArea && !completedAreas.includes(area)) ?? "";
  // Execution prompt composed from typed context layers (audit phase 3):
  // static instructions + scope block + rules + server-owned task board
  // (phase 6 — the model never rediscovers completed tasks). The system
  // half is stable per run; the task board is re-rendered per round so
  // the model always sees current server-owned statuses.
  const tasks: ExplorationTask[] = buildTasks(scope);
  const buildExecutionPrompt = () =>
    composeExecutionPrompt({
      systemPrompt,
      scope,
      completedAreas,
      currentArea,
      nextArea,
      taskBoard: renderTaskState(tasks, selectNextTask(tasks)),
    });
  // Skill exposure telemetry: which skill ids were loaded into this run's prompt.
  const runSkillIds = loadInstalledSkillsSync().map((s) => s.id);
  const wantsVisualEvidence = messages.some(
    (message) =>
      message.role === "user" &&
      /screenshot|screenshots|bukti visual|bukti gambar|lihat tampilan/i.test(message.content)
  );
  let llm: ReturnType<typeof getModel>;
  try {
    // apiKey kosong/marker → pakai key dari vault server (lihat lib/key-vault).
    llm = getModel(provider, chosenModel, resolveKey(provider, apiKey), baseUrl);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "model configuration failed" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const runId = createRun();
  // Durable event log: lets the UI reconnect to a run after a reload.
  await startRunLog(runId, sessionId).catch(() => null);
  // client disconnect (tutup tab / abort fetch) otomatis = cancel run
  req.signal.addEventListener("abort", () => cancelRun(runId));
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let terminal: "done" | "aborted" | "error" = "error";
      const safeClose = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      };
      const send = (event: string, data: unknown) => {
        if (event === "done") terminal = "done";
        else if (event === "aborted") terminal = "aborted";
        else if (event === "error") terminal = "error";
        if (closed || req.signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
          if (event !== "init") void logRunEvent(runId, event, data);
        } catch {
          closed = true;
        }
      };
      send("init", { runId });
      // Heartbeat: SSE comment every 15s so idle stretches (long model
      // thinking gaps with zero tool events) don't look dead to proxies
      // or the browser. Comment frames are ignored by the client parser.
      const heartbeat = setInterval(() => {
        if (closed || req.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      // Satu span untuk seluruh run; tiap tool call jadi child span
      // (dibuat di lib/agent.ts), jadi trace tree-nya utuh.
      try {
        await withSpan("chat.run", async () => {
        const delegateTask = async (task: string) => {
          if (isCancelled(runId)) throw new Error(RUN_CANCELLED);
           send("status", { label: "Delegating QA subtask…", thinking: "Breaking the browser work into a smaller QA subtask." });
          const subTools = getBrowserTools(
             (toolName, input) => send("status", { label: `Sub-agent: ${statusLabel(toolName, input)}`, thinking: thinkingFor(toolName, input), phase: phaseFor(toolName), agent: "sub", tool: toolName }),
            () => isCancelled(runId),
            undefined,
            undefined,
            runId
          );
          const subStarted = Date.now();
          const subResult = await generateText({
            model: llm,
            system:
               "You are a QA sub-agent. Work only on the assigned subtask. " +
               "Explore briefly, use at most 8 tool steps, then return a concise factual result to the main agent. " +
               "You cannot approve shell commands: stick to read-only commands (ls, cat, grep) and never run node/npm/npx. " +
               "Do not delegate again.",
            messages: [{ role: "user", content: task }],
            tools: subTools,
            stopWhen: stepCountIs(8),
            abortSignal: req.signal,
          });
          recordTokenUsage({
            runId,
            phase: "EXPLORATION",
            round: 0,
            agent: "sub",
            model: chosenModel,
            provider,
            usage: subResult.usage as TokenUsageInput | undefined,
            requestChars: task.length + 600,
            responseChars: (subResult.text ?? "").length,
            durationMs: Date.now() - subStarted,
          });
          return {
            role: "qa_subagent",
            task,
            text: subResult.text || "Sub-agent finished without a summary.",
          };
        };

        const awaitApproval = async (toolName: string, input: unknown) => {
          if (isCancelled(runId)) return false;
          if (isAlwaysAllowed(runId)) return true;
          const { id, promise } = createApproval(runId);
          send("approval", { id, runId, tool: toolName, input });
          return promise;
        };

        const actionLimit = Math.max(1, Math.min(MAX_STEPS, scope.maxActions));
        let browserActionsExecuted = 0;
        const toolCalls: { tool: string; input: unknown }[] = [];

        const tools = getBrowserTools(
          (toolName, input) => {
             if (isBrowserAction(toolName)) {
               browserActionsExecuted += 1;
               recordBrowserAction(runId);
             }
             toolCalls.push({ tool: toolName, input });
             lastLabel = statusLabel(toolName, input);
             lastPhase = phaseFor(toolName);
             send("status", { label: lastLabel, thinking: thinkingFor(toolName, input), phase: lastPhase, agent: "main", tool: toolName });
          },
          () => isCancelled(runId),
          delegateTask,
          awaitApproval,
          runId,
          (toolName) => !isBrowserAction(toolName) || browserActionsExecuted < actionLimit
        );

        let modelMessages: ModelMessage[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const screenshots: { url: string; image: string }[] = [];
        const artifacts: { kind: string; file: string; meta: Record<string, unknown> }[] = [];
        const observedAreas = new Set<string>();
        const verifiedAreas = new Set<string>();
        // Evidence ledger: every SUCCESSFUL browser fact the final report
        // may cite. Failed/denied tool calls are never evidence.
        // The LLM never writes the final table — renderReportMarkdown() does,
        // using only entries recorded here.
        const ledger: EvidenceEntry[] = [];
        const testRuns: TestRunSummary[] = [];
        let fullText = "";
        let usage: unknown = null;
        let tokensUsed = 0;
        // Phase 7: configurable budgets (env-driven, per-phase shares).
        const budgets: Budgets = loadBudgets();
        const runStartedAt = Date.now();
        let modelRounds = 0;
        let lastShotUrl: string | null = null;
        let lastLabel = "Working…";
        let lastPhase = "Explore";
        let autoShots = 0;
        let consecutiveTimeouts = 0;
        const MAX_CONSECUTIVE_TIMEOUTS = 3;
        // A single model step must never hang forever: cap it, then let the
        // loop retry (or finish with a partial summary after repeated timeouts).
        const STEP_TIMEOUT_MS = 120_000;
        let capped = false;
        let stopReason: "completed" | "action_limit" | "model_timeout" | "model_round_limit" | "budget_limit" = "completed";
        let earlyStops = 0;
        const MAX_AUTO_SHOTS = 6;
        await saveExplorationCheckpoint({
          runId,
          ...scope,
          completedAreas,
          currentArea,
          nextArea,
          lastAction: previousCheckpoint?.lastAction ?? "",
        });

        // Artifact saves and the final text need rounds of their own; they do
        // not consume the browser-action budget.
        const maxModelRounds = Number.isFinite(actionLimit) ? actionLimit + 8 : MAX_UNBOUNDED_MODEL_ROUNDS;
        const reportingTools = Object.fromEntries(
          Object.entries(tools).filter(([name]) => !isBrowserAction(name))
        );
        let browserBudgetReached = false;
        let budgetWarningSent = false;
        for (let i = 0; i < maxModelRounds; i++) {
          if (isCancelled(runId)) {
            send("aborted", {});
            return;
          }
          const runTokens = getRunTokenStats(runId);
          const verdict = evaluateBudget({
            budgets,
            phaseTokens: {
              EXPLORATION: runTokens?.byPhase.EXPLORATION.totalTokens ?? 0,
              VERIFICATION: runTokens?.byPhase.VERIFICATION.totalTokens ?? 0,
              REPORTING: runTokens?.byPhase.REPORTING.totalTokens ?? 0,
            },
            totalTokens: runTokens?.totalTokens ?? 0,
            modelRounds,
            browserActions: browserActionsExecuted,
            elapsedMs: Date.now() - runStartedAt,
          });
          if (verdict.exceeded) {
            stopReason = "budget_limit";
            capped = true;
            send("status", {
              label: "Token budget reached",
              thinking: `Run stopped: ${verdict.reason} (${(runTokens?.totalTokens ?? 0).toLocaleString()} tokens used, limit ${budgets.maxRunTokens.toLocaleString()}). Completed evidence and task state are saved; unfinished areas stay incomplete.`,
              phase: "Reporting",
              agent: "main",
            });
            break;
          }
          const browserActionCount = toolCalls.filter((call) => isBrowserAction(call.tool)).length;
          // Warn based on real browser actions, not model rounds consumed by
          // incremental artifact saves.
          if (!budgetWarningSent && browserActionCount >= Math.floor(actionLimit * 0.75)) {
            budgetWarningSent = true;
            send("status", {
              label: lastLabel,
              thinking: "Browser action budget is nearly full — finish the current area, save its artifact, and report the next area. Do not start a new browser flow.",
              phase: lastPhase,
              agent: "main",
            });
          }
           // Phase 5: compact history when the context budget is exceeded.
           // The summary is server-built from the evidence ledger and task
           // board (no LLM call, no invented facts); raw payloads stay in
           // the evidence store, retrievable by ID.
           if (shouldCompact(modelMessages, budgets.maxContextTokens)) {
             const currentUrl = (await browser.pageUrl(runId).catch(() => null)) ?? "";
             const compaction = compactHistory({
               messages: modelMessages,
               tasks,
               ledger,
               userRequest: latestUserPrompt,
               currentUrl,
               maxRecentTurns: 12,
             });
             if (compaction.compacted) {
               modelMessages = compaction.messages;
               send("status", {
                 label: lastLabel,
                 thinking: `Context compacted — ${compaction.droppedTurns} earlier turns replaced by a server-built summary; full evidence remains in the store.`,
                 phase: lastPhase,
                 agent: "main",
               });
             }
           }
           // Client aborts (Stop button, tab close) must cancel the model call
           // immediately — not after the 120s step timeout.
           const stepStarted = Date.now();
           const stepSignal = AbortSignal.any([req.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]);
           const outcome = await generateText({
             model: llm,
             system: buildExecutionPrompt(),
             messages: modelMessages,
             tools: browserBudgetReached ? reportingTools : tools,
             stopWhen: stepCountIs(1),
             providerOptions: provider === "openai"
               ? { openai: { parallelToolCalls: false } }
               : undefined,
             abortSignal: stepSignal,
           }).then(
             (r) => ({ ok: true as const, r }),
             (e: unknown) => ({ ok: false as const, e })
           );
           if (!outcome.ok) {
             if (isCancelled(runId)) {
               send("aborted", {});
               return;
             }
             consecutiveTimeouts += 1;
             if (consecutiveTimeouts > MAX_CONSECUTIVE_TIMEOUTS) {
               stopReason = "model_timeout";
               capped = true;
               send("status", {
                 label: "Model timeout",
                 thinking: "The model timed out three times. The run stopped before reliable browser exploration completed; retry or split the scope into a smaller request.",
                 phase: "Reporting",
                 agent: "main",
               });
               break;
             }
             send("status", {
               label: lastLabel,
               thinking: `Model step timed out after 120s (${consecutiveTimeouts}/3) — retrying the step.`,
               agent: "main",
             });
             i -= 1;
             continue;
           }
           const result = outcome.r;
           consecutiveTimeouts = 0;
          modelRounds += 1;
          const step = result.steps[0];
          // Centralized token accounting: exactly one record per provider
          // request. Phase is VERIFICATION when this round ran deterministic
          // assertions, otherwise EXPLORATION.
          const roundPhase: TokenPhase = (step?.toolCalls ?? []).some(
            (t) => t.toolName === "test_assert"
          )
            ? "VERIFICATION"
            : "EXPLORATION";
          const tokenRecord = recordTokenUsage({
            runId,
            phase: roundPhase,
            round: i,
            agent: "main",
            model: chosenModel,
            provider,
            usage: result.usage as TokenUsageInput | undefined,
            requestChars: Number.isFinite(result.usage?.inputTokens)
              ? undefined
              : buildExecutionPrompt().length + JSON.stringify(modelMessages).length,
            responseChars: (result.text ?? "").length,
            durationMs: Date.now() - stepStarted,
          });
          const runStats = getRunTokenStats(runId);
          tokensUsed = runStats?.totalTokens ?? 0;
          const usageSnap = usageSnapshot(runStats);
          usage = usageSnap;
          send("usage", {
            ...usageSnap,
            rounds: runStats?.rounds ?? 0,
            estimated: tokenRecord.estimated,
          });
          if (result.text) fullText += (fullText ? "\n" : "") + result.text;
          // Raw model reasoning: stream the step's actual text instead of
          // only the canned per-tool summary, so "Agent thinking" is verbatim.
          const rawThinking = result.text.trim();
          if (rawThinking && (step?.toolCalls?.length ?? 0) > 0) {
            send("status", {
              label: lastLabel,
              thinking: rawThinking.slice(0, 800),
              phase: lastPhase,
              agent: "main",
            });
          }

          const lastTool = step?.toolCalls?.at(-1)?.toolName;
          if (lastTool) {
            await saveExplorationCheckpoint({
              runId,
              ...scope,
              completedAreas,
              currentArea,
              nextArea,
              lastAction: lastTool,
            });
          }
           const compactOverrides = new Map<string, string>();
          for (let ti = 0; ti < (step?.toolResults ?? []).length; ti += 1) {
             const tr = (step?.toolResults ?? [])[ti];
             recordToolResult(runId, tr.toolName, tr.output);
             const toolCallId =
               typeof (tr as { toolCallId?: unknown }).toolCallId === "string"
                 ? (tr as { toolCallId: string }).toolCallId
                 : "";
             // Fix 1: failed or denied tool calls are NOT evidence. A click on
             // a nonexistent selector must not land its selector in the report.
             const trRec = tr as unknown as Record<string, unknown>;
             if (
               trRec.state === "output-error" ||
               trRec.state === "output-denied" ||
               trRec.isError === true ||
               typeof trRec.errorText === "string"
             ) {
               continue;
             }
             const tc = (step?.toolCalls ?? [])[ti] as unknown as
               | { args?: unknown; input?: unknown }
               | undefined;
             const rawArgs = (tc?.args ?? tc?.input ?? {}) as Record<string, unknown>;
             const toolName = tr.toolName;
             const selector =
               typeof rawArgs.selector === "string"
                 ? rawArgs.selector
                 : typeof rawArgs.from === "string"
                   ? `${String(rawArgs.from)} → ${String(rawArgs.to ?? "")}`
                   : undefined;
              const out = tr.output as unknown;
              if (out && typeof out === "object") {
                const output = out as Record<string, unknown>;
                let evidenceId: string | undefined;
                // Error pages are visits, never verification — a snapshot of
                // a 404 must not mark its area Verified.
                const pageText =
                  typeof output.elements === "string"
                    ? output.elements
                    : typeof output.text === "string"
                      ? output.text
                      : typeof output.actual === "string"
                        ? output.actual
                        : "";
                const errorPage =
                  ["browser_snapshot", "browser_get_text"].includes(toolName) &&
                  looksLikeErrorPage(pageText);
                // Phase 8: area coverage is computed from the evidence
                // ledger by lib/coverage after this loop — the old
                // URL/substring heuristic (any snapshot of a matching URL
                // marked the area Verified) is gone. A passing assertion
                // is now required for VERIFIED.
                // Record evidence for server-side report validation.
                if (isBrowserAction(toolName)) {
                  const url = typeof output.url === "string" ? output.url : "";
                  // Phase 4B: content-addressed dedup. A byte-identical
                  // observation of the same URL is suppressed from the model
                  // context (any material page change changes the hash, so
                  // cart adds, modals, and lazy loads are never deduplicated).
                  const observationContent =
                    toolName === "browser_snapshot" && typeof output.elements === "string"
                      ? output.elements
                      : toolName === "browser_get_text" && typeof output.text === "string"
                        ? output.text
                        : "";
                  const dup = observationContent
                    ? checkDuplicate(runId, url, observationContent)
                    : null;
                  if (dup?.duplicate && toolCallId) {
                    compactOverrides.set(
                      toolCallId,
                      duplicateMarker(toolName, url, dup.previousEvidenceId ?? "the earlier observation")
                    );
                  } else {
                  // Full payload to the evidence store (phase 3, layer E) —
                  // retrievable by evidence ID after context compaction.
                  // The ledger below keeps its trimmed excerpt for reports.
                  const kind: EvidenceKind =
                    toolName === "browser_snapshot"
                      ? "snapshot"
                      : toolName === "browser_get_text"
                        ? "text"
                        : toolName === "browser_screenshot"
                          ? "screenshot"
                          : toolName === "test_assert"
                            ? "assert"
                            : toolName === "browser_console"
                              ? "console"
                              : toolName === "browser_network_log"
                                ? "network"
                                : toolName === "browser_navigate" || toolName === "browser_go_back"
                                  ? "navigation"
                                  : "action";
                  const evidenceRecord = await appendEvidence(runId, {
                    kind,
                    tool: toolName,
                    url,
                    ...(selector ? { selector } : {}),
                    ...(toolName === "test_assert" ? { pass: output.pass === true } : {}),
                    data: out,
                  });
                  evidenceId = evidenceRecord.id;
                  if (observationContent) {
                    rememberObservation(runId, url, observationContent, evidenceRecord.id);
                  }
                  }
                  let excerpt = "";
                  if (typeof output.elements === "string") excerpt = output.elements.slice(0, 2000);
                  else if (typeof output.text === "string") excerpt = output.text.slice(0, 2000);
                  else if (typeof output.actual === "string") excerpt = output.actual.slice(0, 500);
                  else if (typeof output.title === "string") excerpt = `title: ${output.title}`.slice(0, 300);
                  if (errorPage && excerpt) excerpt = `[possible error page] ${excerpt}`;
                  ledger.push({
                    tool: toolName,
                    url,
                    ...(selector ? { selector } : {}),
                    ...(excerpt ? { excerpt } : {}),
                    ...(toolName === "test_assert"
                      ? {
                          pass: output.pass === true,
                          assertKind: typeof rawArgs.kind === "string" ? rawArgs.kind : undefined,
                        }
                      : {}),
                    ...(evidenceId ? { evidenceId } : {}),
                  });
                }
                // Fix 3: record test execution outcomes for the report's
                // Verification results section (never silently dropped).
                if (toolName === "test_run") {
                  testRuns.push({
                    ...(typeof rawArgs.file === "string" ? { file: rawArgs.file } : {}),
                    ...(typeof output.ok === "boolean" ? { ok: output.ok } : {}),
                    ...(typeof output.passed === "number" ? { passed: output.passed } : {}),
                    ...(typeof output.failed === "number" ? { failed: output.failed } : {}),
                    ...(typeof output.error === "string" ? { error: output.error } : {}),
                  });
                }
                // Phase 4C/4D: large results enter the model context as a
                // compact summary + evidence ID. evidence_read is exempt —
                // the model explicitly asked for the full payload.
                if (toolCallId && toolName !== "evidence_read" && !compactOverrides.has(toolCallId)) {
                  const compacted = compactToolResult(toolName, out, evidenceId);
                  if (compacted.compacted) compactOverrides.set(toolCallId, compacted.summary);
                }
              }
              if (out && typeof out === "object" && "saved" in (out as Record<string, unknown>)) {
                const result = out as Record<string, unknown>;
                const file = String(result.saved);
                const kind = file.endsWith(".md") ? "Test Plan Document" : file.endsWith(".cases.json") ? "Test Cases" : "Automation";
                const savedAreas = result.areas && typeof result.areas === "object"
                  ? Object.keys(result.areas as Record<string, unknown>).map((area) => area.toLowerCase())
                  : [];
                const unverifiedAreas = savedAreas.filter((area) => !verifiedAreas.has(area));
                const artifactMeta = {
                  ...result,
                  ...(savedAreas.length ? {
                    coverage: {
                      artifactAreas: savedAreas,
                      verifiedAreas: savedAreas.filter((area) => observedAreas.has(area)),
                      unverifiedAreas,
                    },
                  } : {}),
                  qualityGate: result.qualityGate && typeof result.qualityGate === "object"
                    ? {
                        ...(result.qualityGate as Record<string, unknown>),
                        complete: Boolean((result.qualityGate as Record<string, unknown>).complete) && unverifiedAreas.length === 0,
                        unverifiedAreas,
                      }
                    : result.qualityGate,
                };
                if (savedAreas.includes(currentArea.toLowerCase()) && verifiedAreas.has(currentArea.toLowerCase())) {
                  completedAreas = [...new Set([...completedAreas, currentArea])];
                  await saveExplorationCheckpoint({
                    runId,
                    ...scope,
                    completedAreas,
                    currentArea,
                    nextArea: scope.areas.find((area) => !completedAreas.includes(area)) ?? "",
                    lastAction: "artifact_saved",
                  });
                }
                // Dedupe by filename: re-saves (e.g. spec fix after a failed
                // run) replace the earlier entry instead of doubling it.
                const existing = artifacts.findIndex((a) => a.file === file);
                const entry = { kind, file, meta: artifactMeta };
                if (existing >= 0) artifacts[existing] = entry;
                else artifacts.push(entry);
              }
            if (
              out &&
              typeof out === "object" &&
              "image" in (out as Record<string, unknown>) &&
              typeof (out as Record<string, unknown>).image === "string"
            ) {
              screenshots.push(out as { url: string; image: string });
            }
          }

          // Phase 8: recompute every task's status from the evidence
          // ledger, then re-derive the coverage sets the rest of the loop
          // uses. Statuses are backend-owned; the model cannot claim them.
          const refreshedTasks = refreshTaskStatuses(tasks, ledger);
          tasks.splice(0, tasks.length, ...refreshedTasks);
          verifiedAreas.clear();
          observedAreas.clear();
          for (const t of tasks) {
            if (t.status === "VERIFIED") verifiedAreas.add(t.area.toLowerCase());
            if (t.status !== "NOT_STARTED" && t.status !== "SKIPPED") {
              observedAreas.add(t.area.toLowerCase());
            }
          }
          completedAreas = completedTaskAreas(tasks);

          modelMessages = [
            ...modelMessages,
            ...rewriteToolOutputs(result.response.messages, compactOverrides),
          ];

          // auto-shot hemat: hanya kalau pindah halaman (URL berubah) atau
          // navigate eksplisit — bukan tiap ketik/klik. Maks 6 per run.
          const stepTools = (step?.toolCalls ?? []).map((t) => t.toolName);
          if (
            wantsVisualEvidence &&
            autoShots < MAX_AUTO_SHOTS &&
            !stepTools.includes("browser_screenshot") &&
            stepTools.some((t) =>
              ["browser_navigate", "browser_click", "browser_type"].includes(t)
            )
          ) {
            try {
              const currentUrl = await browser.pageUrl(runId);
              const navigated = stepTools.includes("browser_navigate");
              if (navigated || (currentUrl && currentUrl !== lastShotUrl)) {
                const shot = await browser.screenshot(false, runId);
                screenshots.push(shot);
                send("shot", shot);
                lastShotUrl = shot.url;
                autoShots += 1;
              }
            } catch {}
          }

          if (browserActionsExecuted >= actionLimit) {
            browserBudgetReached = true;
            stopReason = "action_limit";
          }
          if ((step?.toolCalls?.length ?? 0) === 0) {
            // The model stopped calling tools. If coverage is incomplete, nudge
            // it back to work (bounded) instead of accepting a near-empty run.
            const uncovered = scope.areas.filter((a) => !verifiedAreas.has(a.toLowerCase()));
            if (uncovered.length && !browserBudgetReached && earlyStops < 3) {
              earlyStops += 1;
              modelMessages = [
                ...modelMessages,
                {
                  role: "user",
                  content: `You stopped with these requested areas still unverified: ${uncovered.join(", ")}. Do not summarize yet — continue exploring them with browser tools now (snapshot each area, assert key outcomes with test_assert).`,
                },
              ];
              send("status", {
                label: lastLabel,
                thinking: `Coverage incomplete (${uncovered.join(", ")} unverified) — resuming exploration instead of stopping early (nudge ${earlyStops}/3).`,
                phase: lastPhase,
                agent: "main",
              });
              continue;
            }
            break;
          }
          if (i === maxModelRounds - 1) {
            capped = true;
            stopReason = "model_round_limit";
          }
        }

        if (!capped) {
          await saveExplorationCheckpoint({
            runId,
            ...scope,
            completedAreas,
            currentArea,
            nextArea: scope.areas.find((area) => !completedAreas.includes(area)) ?? "",
            lastAction: "completed",
          });
        } else {
          // Phase 7 graceful exhaustion: persist task state so a resume
          // continues from the task board, not from a lost transcript.
          await saveExplorationCheckpoint({
            runId,
            ...scope,
            completedAreas,
            currentArea,
            nextArea: scope.areas.find((area) => !completedAreas.includes(area)) ?? "",
            lastAction: `stopped:${stopReason}`,
          }).catch(() => null);
        }

        const finalBrowserActions = browserActionsExecuted;
        // Phase 8/9: coverage comes from the backend-computed task board.
        const coverageSummary = summarizeCoverage(tasks, { capped, stopReason });
        const coveredAreas = coverageSummary.coveredAreas;
        const visitedAreas = coverageSummary.visitedAreas;
        const coverageStatus = coverageSummary.overall;
        const coverage = {
          requestedAreas: coverageSummary.requestedAreas,
          visitedAreas,
          coveredAreas,
          areaStatuses: coverageSummary.areaStatuses,
          overall: coverageSummary.overall,
        };
        // STRUCTURED REPORT: the model returns DATA ONLY (JSON). Status,
        // locator filtering, banned-claim stripping, and Markdown rendering
        // all happen server-side. Model status is never trusted.
        // NOTE: compact context on purpose — full modelMessages carries every
        // snapshot verbatim and makes this call slow/flaky on some gateways.
        // Two tiers: generateObject (json_schema) first, then plain-text JSON
        // with strict server-side parse for gateways lacking schema support.
        // The structured summary can take 10–60s: announce the Reporting
        // phase so the client progress bar leaves Testing behind.
        send("status", {
          label: "Compiling final report…",
          thinking: "Browser actions are complete; validating evidence and rendering the server-verified report.",
          phase: "Reporting",
          agent: "main",
        });
        let finalReport: string;
        {
          const ledgerSummary = ledger
            .slice(-60)
            .map((e) => `- ${e.tool} ${e.url}${e.selector ? ` [${e.selector}]` : ""}${e.pass !== undefined ? (e.pass ? " PASS" : " FAIL") : ""}${e.excerpt ? `: ${e.excerpt.slice(0, 200)}` : ""}`)
            .join("\n");
          const testRunSummary = testRuns
            .map((r) => `- test run (${r.file || "all"}): ${r.error ? `ERROR ${r.error.slice(0, 160)}` : `${r.passed ?? 0} passed, ${r.failed ?? 0} failed`}`)
            .join("\n");
          const scribeRules =
            "You are a QA scribe. Return exploration findings as JSON data only. " +
            "Rules: every feature MUST carry a quote copied verbatim from the browser evidence (a feature without a matching quote is dropped); list only locators appearing verbatim in the evidence; " +
            "never claim CAPTCHA/rate-limit/bot-check/auth-wall absence, full testability, or universal accessibility unless a passing assertion proves it; " +
            "do NOT decide Verified/Visited/Planned — the server assigns status. Omit anything unobserved instead of inventing it.";
          const scribeRequest = `Summarize this exploration as JSON.\nRequested areas: ${scope.areas.join(", ") || "none"}.\nServer-verified areas (do not relabel): ${coveredAreas.join(", ") || "none"}. Visited only: ${visitedAreas.filter((a) => !coveredAreas.includes(a)).join(", ") || "none"}.\nTest executions:\n${testRunSummary || "(no test runs)"}\nLast agent notes:\n${fullText.slice(-4000) || "(none)"}\nBrowser evidence ledger:\n${ledgerSummary || "(no browser evidence)"}\nReturn summary, per-area features+evidence+gaps, observed locators, and gaps. Quote evidence verbatim from the ledger excerpts; the server drops anything else.`;
          const JSON_SHAPE =
            `Return ONLY a JSON object (no markdown fences) with exactly this shape: ` +
            `{"summary": string, "areas": [{"area": string, "features": [{"text": string, "quote": string}], "evidence": [string], "gaps": string}], ` +
            `"locators": [{"element": string, "locator": string, "type": string}], "gaps": [string]}`;
          const extractJson = (text: string): unknown => {
            const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
            const start = fenced.indexOf("{");
            const end = fenced.lastIndexOf("}");
            if (start < 0 || end <= start) throw new Error("no JSON object in scribe reply");
            return JSON.parse(fenced.slice(start, end + 1));
          };
          let object: z.infer<typeof ReportDataSchema> | null = null;
          let structuredError: unknown = null;
          const scribeStarted = Date.now();
          try {
            const res = await generateObject({
              model: llm,
              schema: ReportDataSchema,
              system: scribeRules,
              messages: [{ role: "user", content: scribeRequest }],
              abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]),
            });
            object = res.object;
            recordTokenUsage({
              runId,
              phase: "REPORTING",
              round: modelRounds,
              agent: "main",
              model: chosenModel,
              provider,
              usage: res.usage as TokenUsageInput | undefined,
              requestChars: Number.isFinite(res.usage?.inputTokens)
                ? undefined
                : scribeRules.length + scribeRequest.length,
              responseChars: JSON.stringify(object).length,
              durationMs: Date.now() - scribeStarted,
            });
          } catch (e) {
            structuredError = e;
            try {
              const res2 = await generateText({
                model: llm,
                system: `${scribeRules} ${JSON_SHAPE}`,
                messages: [{ role: "user", content: scribeRequest }],
                abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]),
              });
              recordTokenUsage({
                runId,
                phase: "REPORTING",
                round: modelRounds,
                agent: "main",
                model: chosenModel,
                provider,
                usage: res2.usage as TokenUsageInput | undefined,
                requestChars: Number.isFinite(res2.usage?.inputTokens)
                  ? undefined
                  : scribeRules.length + JSON_SHAPE.length + scribeRequest.length,
                responseChars: (res2.text ?? "").length,
                durationMs: Date.now() - scribeStarted,
              });
              const parsed = ReportDataSchema.safeParse(extractJson(res2.text));
              if (parsed.success) object = parsed.data;
              else structuredError = parsed.error;
            } catch (e2) {
              structuredError = e2;
            }
          }
          if (object) {
            finalReport = renderReportMarkdown(object, coverage, ledger, testRuns);
          } else {
            // No hallucinated fallback: coverage + ledger only.
            console.error(`run ${runId} structured report failed, using fallback:`, structuredError instanceof Error ? structuredError.message : structuredError);
            finalReport = renderFallbackReport(coverage, finalBrowserActions, ledger, testRuns);
          }
        }
        const capMessage = stopReason === "model_timeout"
          ? "\n\n---\nRun stopped: the model timed out three times before reliable exploration completed. Retry this request or split it into a smaller area."
          : stopReason === "action_limit"
            ? `\n\n---\nStopped early: reached the ${actionLimit}-browser-action limit before finishing. Ask me to continue from where it left off.`
            : stopReason === "model_round_limit"
              ? `\n\n---\nStopped after ${maxModelRounds} model rounds with ${finalBrowserActions} browser actions. Ask me to continue from where it left off.`
              : stopReason === "budget_limit"
                ? `\n\n---\nStopped early: this run reached its ${budgets.maxRunTokens.toLocaleString()}-token budget (${tokensUsed.toLocaleString()} used). Raise MAX_RUN_TOKENS or split the request. Completed evidence is saved; unfinished areas are marked incomplete, not verified.`
                : "";
        const runFacts = `\n\n---\nAUTHORITATIVE EXPLORATION STATUS: ${coverageStatus}. Run facts (server-verified): ${finalBrowserActions} browser actions executed. Verified areas: ${coveredAreas.length ? coveredAreas.join(", ") : "none"}.${visitedAreas.filter((area) => !coveredAreas.includes(area)).length ? ` Visited only: ${visitedAreas.filter((area) => !coveredAreas.includes(area)).join(", ")}.` : ""}${scope.areas.filter((area) => !coveredAreas.includes(area)).length ? ` Next requested area: ${scope.areas.find((area) => !coveredAreas.includes(area))}.` : " All requested areas verified."}${scopeWarning ? ` Warning: ${scopeWarning}` : ""}`;
        send("done", {
          text:
            `${runFacts}\n\n${finalReport}${capMessage}` ||
            (capped
              ? "Agent reached the step limit before finishing the summary. Continue from the last exploration or split the request into smaller areas."
              : "Tools finished, but the model did not send a summary."),
          toolCalls,
           screenshots,
           artifacts,
          browserActions: toolCalls.filter((call) => isBrowserAction(call.tool)).length,
          artifactActions: toolCalls.filter((call) => isArtifactAction(call.tool)).length,
          modelRounds,
          requestedAreas: scope.areas,
          completedAreas,
          coverage: {
            requestedAreas: scope.areas,
            visitedAreas,
            coveredAreas,
            missingAreas: scope.areas.filter((area) => !coveredAreas.includes(area.toLowerCase())),
          },
          stopReason,
          skills: runSkillIds,
          usage,
          model: chosenModel,
          provider,
          capped,
          tokenStats: getRunTokenStats(runId),
          tasks: tasks.map((t) => ({
            id: t.id,
            area: t.area,
            status: t.status,
            evidenceIds: t.evidenceIds,
            ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
          })),
          budget: {
            maxRunTokens: budgets.maxRunTokens,
            usedTokens: getRunTokenStats(runId)?.totalTokens ?? 0,
            phaseTokens: {
              EXPLORATION: getRunTokenStats(runId)?.byPhase.EXPLORATION.totalTokens ?? 0,
              VERIFICATION: getRunTokenStats(runId)?.byPhase.VERIFICATION.totalTokens ?? 0,
              REPORTING: getRunTokenStats(runId)?.byPhase.REPORTING.totalTokens ?? 0,
            },
          },
          // Fix D: persist the evidence ledger + test outcomes in done.data so
          // any report can be re-audited post-hoc (excerpts trimmed for size).
          ledger: ledger.map((e) => ({
            ...e,
            excerpt: e.excerpt ? e.excerpt.slice(0, 500) : undefined,
          })),
          testRuns,
        });
        }, {
          "provider": provider,
          "model": chosenModel,
          ...(sessionId ? { "session.id": sessionId } : {}),
          "run.id": runId,
        });
      } catch (e) {
        if (
          isCancelled(runId) ||
          (e instanceof Error && e.message.includes(RUN_CANCELLED))
        ) {
          console.log(`run ${runId} cancelled by user`);
          try {
            send("aborted", {});
          } catch {}
        } else {
          console.error("chat stream error:", e);
          send("error", {
            error: e instanceof Error ? e.message : "Unknown error",
          });
        }
      } finally {
        clearInterval(heartbeat);
        rejectRunApprovals(runId);
        endRun(runId);
        clearRunTokens(runId);
        clearObservations(runId);
        await browser.closeSession(runId).catch(() => null);
        await flushLogs().catch(() => null);
        await finishRunLog(runId, terminal).catch(() => null);
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
