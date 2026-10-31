import { tool } from "ai";
import { z } from "zod";
import * as browser from "./browser";
import { getEvidence } from "./evidence-store";
import { saveSpec, runSpec, mergeCases, saveCaseResults, savePlanDocument, recordRun, listSpecs } from "./specs";
import { saveFact, forgetFact } from "./memory";
import { RUN_CANCELLED } from "./runs";
import { recordToolLog } from "./tool-logs";
import { withSpan } from "./telemetry";

const TestCaseSchema = z.object({
  id: z.string().describe("Unique ID, for example TC-001"),
  area: z.string().describe("Feature area, for example Login"),
  type: z.string().describe("Positive / Negative / Boundary / other"),
  title: z.string().describe("Case title — MUST exactly match the test() name in the spec"),
  preconditions: z.string().optional().default(""),
  testData: z.string().optional().default(""),
  steps: z.array(z.string()).describe("Step 1, 2, 3..."),
  expected: z.string().describe("Expected result"),
  priority: z.enum(["High", "Medium", "Low"]).optional().default("Medium"),
  severity: z.enum(["High", "Medium", "Low"]).optional().default("Medium"),
});

const PlanItemSchema = z.object({ key: z.string(), value: z.string() });
const PlanRoleSchema = z.object({ role: z.string(), name: z.string(), responsibility: z.string() });
const PlanScheduleSchema = z.object({ event: z.string(), startDate: z.string(), endDate: z.string() });
const PlanRiskSchema = z.object({ risk: z.string(), mitigation: z.string() });
const PlanApprovalSchema = z.object({ name: z.string(), role: z.string(), signature: z.string() });

export { statusLabel, IDLE_STATUS, THINKING_STATUS } from "./agent-status";

// Tools that pause for explicit user approval before executing.
// Extend this set to gate more tools; approval UI lives in Chat.tsx,
// resolution arrives via POST /api/chat/approve.
const APPROVAL_TOOLS = new Set(["browser_bash"]);

// Dipakai /api/chat/stream (SSE per-step).
// onCall dipanggil TEPAT SEBELUM tool dieksekusi → cocok untuk status real-time.
// shouldAbort dicek sebelum tiap tool → implementasi interrupt.
// awaitApproval dipanggil untuk tool sensitif → human-in-the-loop (resep AI SDK).
export function getBrowserTools(
  onCall?: (toolName: string, input: unknown) => void,
  shouldAbort?: () => boolean,
  delegateTask?: (task: string) => Promise<unknown>,
  awaitApproval?: (toolName: string, input: unknown) => Promise<boolean>,
  // Isolated browser session for this run. When set, all browser tools act
  // on the run's own BrowserContext; when unset they use the shared page.
  runId?: string,
  canExecute?: (toolName: string) => boolean
) {
  // Session id captured once — every tool lambda below closes over it.
  const sid = runId;
  const wrap = <T extends object>(
    toolName: string,
    fn: (input: T) => Promise<unknown>
  ) => {
    return async (input: T) => {
      if (shouldAbort?.()) throw new Error(RUN_CANCELLED);
      if (canExecute && !canExecute(toolName)) {
        throw new Error("Browser action budget reached. Save the current artifact and report the next area.");
      }
      if (APPROVAL_TOOLS.has(toolName)) {
        if (!awaitApproval) {
          // No approval channel (e.g. sub-agent): deny by default.
          // Only provably side-effect-free commands pass without a human.
          const cmd = (input as { command?: unknown } | null)?.command;
          if (typeof cmd !== "string" || !browser.isReadOnlyCommand(cmd)) {
            throw new Error(
              `User denied ${toolName}. Do not retry it; inform the user the action was not performed.`
            );
          }
        } else {
          const approved = await awaitApproval(toolName, input);
          if (shouldAbort?.()) throw new Error(RUN_CANCELLED);
          if (!approved) {
            throw new Error(
              `User denied ${toolName}. Do not retry it; inform the user the action was not performed.`
            );
          }
        }
      }
      try {
        onCall?.(toolName, input);
      } catch {}
      const started = Date.now();
      try {
        const output = await withSpan(`tool.${toolName}`, () => fn(input), {
          "tool.name": toolName,
          ...(sid ? { "run.id": sid } : {}),
        });
        const loggedInput = toolName === "browser_type"
          ? { ...input, text: "[redacted]" }
          : input;
        void recordToolLog({
          tool: toolName,
          status: "success",
          durationMs: Date.now() - started,
          input: loggedInput,
          output,
          runId: sid,
        });
        return output;
      } catch (error) {
        const loggedInput = toolName === "browser_type"
          ? { ...input, text: "[redacted]" }
          : input;
        void recordToolLog({
          tool: toolName,
          status: "error",
          durationMs: Date.now() - started,
          input: loggedInput,
          error: error instanceof Error ? error.message : "tool failed",
          runId: sid,
        });
        throw error;
      }
    };
  };

  return {
    browser_navigate: tool({
       description: "Open a URL in the automated browser",
      inputSchema: z.object({ url: z.string().describe("full URL") }),
      execute: wrap("browser_navigate", async ({ url }: { url: string }) =>
        browser.navigate(url, sid)
      ),
    }),
    browser_snapshot: tool({
      description: "Inspect the active page structure (tag, role, accessible name, text)",
      inputSchema: z.object({
        frameUrl: z.string().optional().describe("inspect inside the iframe whose URL contains this text"),
      }),
      execute: wrap("browser_snapshot", async ({ frameUrl }: { frameUrl?: string }) =>
        browser.snapshot(12000, sid, frameUrl)
      ),
    }),
    browser_get_text: tool({
      description: "Read the visible page text",
      inputSchema: z.object({}),
      execute: wrap("browser_get_text", async () => browser.getText(8000, sid)),
    }),
    browser_click: tool({
       description:
        "Click an element using a CSS selector or numeric snapshot index",
      inputSchema: z.object({
        selector: z.string(),
        frameUrl: z.string().optional().describe("click inside the iframe whose URL contains this text (CSS selector only, no numeric index)"),
      }),
      execute: wrap("browser_click", async ({ selector, frameUrl }: { selector: string; frameUrl?: string }) =>
        browser.click(selector, sid, frameUrl)
      ),
    }),
    browser_type: tool({
       description: "Fill a form input",
      inputSchema: z.object({
        selector: z.string(),
        text: z.string(),
        submit: z.boolean().optional().default(false),
        frameUrl: z.string().optional().describe("type inside the iframe whose URL contains this text"),
      }),
      execute: wrap(
        "browser_type",
        async ({
          selector,
          text,
          submit,
          frameUrl,
        }: {
          selector: string;
          text: string;
          submit?: boolean;
          frameUrl?: string;
        }) => browser.typeText(selector, text, submit, sid, frameUrl)
      ),
    }),
    browser_screenshot: tool({
      description: "Capture a screenshot of the active page (base64 PNG)",
      inputSchema: z.object({
        fullPage: z.boolean().optional().default(false),
      }),
      execute: wrap(
        "browser_screenshot",
        async ({ fullPage }: { fullPage?: boolean }) =>
          browser.screenshot(!!fullPage, sid)
      ),
    }),
    browser_go_back: tool({
      description: "Go back to the previous page",
      inputSchema: z.object({}),
      execute: wrap("browser_go_back", async () => browser.goBack(sid)),
    }),
    browser_scroll: tool({
      description: "Scroll the page to reveal content below the fold, then snapshot again",
      inputSchema: z.object({
        direction: z.enum(["down", "up", "top", "bottom"]).optional().default("down"),
        pixels: z.number().int().min(100).max(5000).optional().default(600),
      }),
      execute: wrap(
        "browser_scroll",
        async ({ direction, pixels }: { direction?: "down" | "up" | "top" | "bottom"; pixels?: number }) =>
          browser.scrollPage(direction ?? "down", pixels ?? 600, sid)
      ),
    }),
    test_assert: tool({
      description: "Run a deterministic assertion against the live page and get a PASS/FAIL result. Use this to verify outcomes instead of eyeballing.",
      inputSchema: z.object({
        kind: z.enum(["text_contains", "visible", "element_text", "count"]).describe("text_contains needs text; visible needs selector; element_text needs selector + text; count needs selector + expected"),
        selector: z.string().optional().default(""),
        text: z.string().optional().default(""),
        expected: z.number().int().min(0).optional().default(1),
      }),
      execute: wrap(
        "test_assert",
        async ({ kind, selector, text, expected }: { kind: "text_contains" | "visible" | "element_text" | "count"; selector?: string; text?: string; expected?: number }) => {
          if (kind === "text_contains") {
            if (!text) throw new Error("text is required for text_contains");
            return browser.assertPage({ kind, text }, sid);
          }
          if (!selector) throw new Error("selector is required for visible/element_text/count");
          if (kind === "element_text") {
            if (!text) throw new Error("text is required for element_text");
            return browser.assertPage({ kind, selector, text }, sid);
          }
          return kind === "visible"
            ? browser.assertPage({ kind, selector }, sid)
            : browser.assertPage({ kind, selector, expected: expected ?? 1 }, sid);
        }
      ),
    }),
    browser_close: tool({
      description: "Close the browser",
      inputSchema: z.object({}),
      execute: wrap("browser_close", async () => {
        await browser.closeSession(sid ?? "");
        return { closed: true };
      }),
    }),
    evidence_read: tool({
      description:
        "Retrieve the full payload of a previous browser observation by its evidence ID (ev_N). Use when a compacted summary or duplicate marker is not enough and you need the raw snapshot, text, or log again. Does not consume the browser-action budget.",
      inputSchema: z.object({
        id: z.string().describe("evidence ID, e.g. ev_12"),
      }),
      execute: wrap("evidence_read", async ({ id }: { id: string }) => {
        const record = await getEvidence(sid ?? "", id);
        if (!record) return { found: false, id };
        return { found: true, id, kind: record.kind, url: record.url, data: record.data };
      }),
    }),
    browser_upload: tool({
      description: "Upload a text file into a file input (content is sent inline)",
      inputSchema: z.object({
        selector: z.string().describe("file input CSS selector"),
        fileName: z.string().describe("file name, e.g. notes.txt"),
        content: z.string().max(20_000).describe("file content"),
        frameUrl: z.string().optional(),
      }),
      execute: wrap(
        "browser_upload",
        async ({ selector, fileName, content, frameUrl }: { selector: string; fileName: string; content: string; frameUrl?: string }) =>
          browser.uploadFile(selector, fileName, content, sid, frameUrl)
      ),
    }),
    browser_press: tool({
      description: "Press a keyboard key, optionally focused on an element (Enter, Tab, Escape, ArrowDown, ...)",
      inputSchema: z.object({
        key: z.string(),
        selector: z.string().optional().default(""),
        frameUrl: z.string().optional(),
      }),
      execute: wrap(
        "browser_press",
        async ({ key, selector, frameUrl }: { key: string; selector?: string; frameUrl?: string }) =>
          browser.pressKey(selector || "", key, sid, frameUrl)
      ),
    }),
    browser_hover: tool({
      description: "Hover over an element to reveal menus, tooltips, or hover states",
      inputSchema: z.object({
        selector: z.string(),
        frameUrl: z.string().optional(),
      }),
      execute: wrap(
        "browser_hover",
        async ({ selector, frameUrl }: { selector: string; frameUrl?: string }) =>
          browser.hover(selector, sid, frameUrl)
      ),
    }),
    browser_drag: tool({
      description: "Drag an element onto another (sliders, drag-and-drop zones, sortable lists)",
      inputSchema: z.object({
        from: z.string().describe("drag source CSS selector"),
        to: z.string().describe("drop target CSS selector"),
        frameUrl: z.string().optional(),
      }),
      execute: wrap(
        "browser_drag",
        async ({ from, to, frameUrl }: { from: string; to: string; frameUrl?: string }) =>
          browser.drag(from, to, sid, frameUrl)
      ),
    }),
    browser_dialog: tool({
      description: "Read captured JS dialogs (alert/confirm/prompt); dialogs auto-accept unless dismissNext is set",
      inputSchema: z.object({
        dismissNext: z.boolean().optional().default(false),
      }),
      execute: wrap("browser_dialog", async ({ dismissNext }: { dismissNext?: boolean }) =>
        browser.readDialog(sid, !!dismissNext)
      ),
    }),
    browser_tabs: tool({
      description: "List open browser tabs (index, URL, title) after popups or target=_blank links",
      inputSchema: z.object({}),
      execute: wrap("browser_tabs", async () => browser.listTabs(sid)),
    }),
    browser_tab_select: tool({
      description: "Switch to a tab by index so later tools act on it",
      inputSchema: z.object({
        index: z.number().int().min(0),
      }),
      execute: wrap("browser_tab_select", async ({ index }: { index: number }) =>
        browser.selectTab(index, sid)
      ),
    }),
    browser_tab_close: tool({
      description: "Close a tab by index (cannot close the last one)",
      inputSchema: z.object({
        index: z.number().int().min(0),
      }),
      execute: wrap("browser_tab_close", async ({ index }: { index: number }) =>
        browser.closeTab(index, sid)
      ),
    }),
    browser_downloads: tool({
      description: "List files captured from downloads, with saved paths and sizes",
      inputSchema: z.object({
        clear: z.boolean().optional().default(false),
      }),
      execute: wrap("browser_downloads", async ({ clear }: { clear?: boolean }) =>
        browser.readDownloads(sid, !!clear)
      ),
    }),
    browser_network_log: tool({
      description: "List recent network requests (method, URL, status, duration) for debugging APIs",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().default(50),
        clear: z.boolean().optional().default(false),
      }),
      execute: wrap(
        "browser_network_log",
        async ({ limit, clear }: { limit?: number; clear?: boolean }) =>
          browser.networkLog(sid, limit ?? 50, !!clear)
      ),
    }),
    browser_console: tool({
      description: "Read console errors, warnings, and page errors for bug reproduction",
      inputSchema: z.object({
        clear: z.boolean().optional().default(false),
      }),
      execute: wrap("browser_console", async ({ clear }: { clear?: boolean }) =>
        browser.consoleLog(sid, !!clear)
      ),
    }),
    browser_select: tool({
      description: "Choose a dropdown option by value or visible label",
      inputSchema: z.object({
        selector: z.string(),
        value: z.string().describe("option value or visible label"),
      }),
      execute: wrap(
        "browser_select",
        async ({ selector, value }: { selector: string; value: string }) =>
          browser.selectOption(selector, value, sid)
      ),
    }),
    browser_wait: tool({
      description: "Wait for an element, page text, or a short delay before continuing",
      inputSchema: z.object({
        selector: z.string().optional().default(""),
        text: z.string().optional().default(""),
        timeoutMs: z.number().int().min(1000).max(30000).optional().default(10000),
      }),
      execute: wrap(
        "browser_wait",
        async ({ selector, text, timeoutMs }: { selector?: string; text?: string; timeoutMs?: number }) =>
          browser.waitFor(
            {
              selector: selector || undefined,
              text: text || undefined,
              timeoutMs: timeoutMs ?? 10000,
            },
            sid
          )
      ),
    }),
    browser_storage: tool({
      description: "Read/write localStorage or sessionStorage (auth tokens, user prefs)",
      inputSchema: z.object({
        action: z.enum(["get", "set", "clear"]).optional().default("get"),
        area: z.enum(["local", "session"]).optional().default("local"),
        key: z.string().optional().default(""),
        value: z.string().optional().default(""),
      }),
      execute: wrap(
        "browser_storage",
        async ({
          action,
          area,
          key,
          value,
        }: {
          action?: "get" | "set" | "clear";
          area?: "local" | "session";
          key?: string;
          value?: string;
        }) => browser.storage(action ?? "get", area ?? "local", key ?? "", value ?? "", sid)
      ),
    }),
    browser_cookies: tool({
      description: "List, set, or clear cookies (session persistence)",
      inputSchema: z.object({
        action: z.enum(["list", "set", "clear"]).optional().default("list"),
        name: z.string().optional().default(""),
        value: z.string().optional().default(""),
        url: z.string().optional(),
      }),
      execute: wrap(
        "browser_cookies",
        async ({
          action,
          name,
          value,
          url,
        }: {
          action?: "list" | "set" | "clear";
          name?: string;
          value?: string;
          url?: string;
        }) => browser.cookies(action ?? "list", name ?? "", value ?? "", url, sid)
      ),
    }),
    browser_bash: tool({
       description: "Run a restricted command without a shell (npm, node, grep, ls, and other safe commands)",
      inputSchema: z.object({ command: z.string().min(1).max(500) }),
      execute: wrap("browser_bash", async ({ command }: { command: string }) =>
        browser.bash(command)
      ),
    }),
    browser_read_file: tool({
       description: "Read allowed project files in read-only mode",
      inputSchema: z.object({
        path: z.string().min(1),
        limit: z.number().int().positive().max(10000).optional(),
      }),
      execute: wrap(
        "browser_read_file",
        async ({ path, limit }: { path: string; limit?: number }) =>
          browser.readFile(path, limit)
      ),
    }),
    browser_delegate: tool({
       description: "Delegate a controlled QA exploration or test-planning subtask",
      inputSchema: z.object({ task: z.string().min(1).max(2_000) }),
      execute: wrap("browser_delegate", async ({ task }: { task: string }) => {
         if (!delegateTask) throw new Error("Sub-agent is not available in this mode");
        return delegateTask(task);
      }),
    }),
    test_save: tool({
      description:
        "Save a Playwright test file (.spec.ts) in tests/ after site exploration",
      inputSchema: z.object({
        file: z
          .string()
          .describe("file path, e.g. login.spec.ts or qabrains-ecommerce/login.spec.ts (group keeps tests/ tidy)"),
        content: z.string().describe("full spec content"),
      }),
      execute: wrap(
        "test_save",
        async ({ file, content }: { file: string; content: string }) =>
          saveSpec(file, content)
      ),
    }),
    test_plan_document: tool({
      description:
        "Save a ten-section QA test plan document as Markdown: Project Information, Objective, Scope, Test Strategy, Deliverables, Environment, Roles, Schedule, Risk & Mitigation, and Approval",
      inputSchema: z.object({
        file: z.string().describe("base file path, e.g. saucedemo-test-plan or qabrains-ecommerce/saucedemo-test-plan"),
        projectName: z.string(),
        testerName: z.string(),
        date: z.string(),
        version: z.string(),
        objective: z.string(),
        inScope: z.array(z.string()),
        outOfScope: z.array(z.string()),
        testStrategy: z.array(z.string()),
        deliverables: z.array(z.string()),
        environment: z.array(PlanItemSchema),
        roles: z.array(PlanRoleSchema),
        schedule: z.array(PlanScheduleSchema),
        risks: z.array(PlanRiskSchema),
        approval: z.array(PlanApprovalSchema),
      }),
      execute: wrap("test_plan_document", async (input: {
        file?: string;
        projectName?: string;
        testerName?: string;
        date?: string;
        version?: string;
        objective?: string;
        inScope?: string[];
        outOfScope?: string[];
        testStrategy?: string[];
        deliverables?: string[];
        environment?: { key?: string; value?: string }[];
        roles?: { role?: string; name?: string; responsibility?: string }[];
        schedule?: { event?: string; startDate?: string; endDate?: string }[];
        risks?: { risk?: string; mitigation?: string }[];
        approval?: { name?: string; role?: string; signature?: string }[];
      }) => {
        if (!input.file) throw new Error("file is required");
        const req = (v: unknown, name: string): string => {
          if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
          return v;
        };
        const arr = (v: unknown, name: string): string[] => {
          if (!Array.isArray(v)) throw new Error(`${name} is required`);
          return v.map(String);
        };
        return savePlanDocument(input.file, {
          projectName: req(input.projectName, "projectName"),
          testerName: req(input.testerName, "testerName"),
          date: req(input.date, "date"),
          version: req(input.version, "version"),
          objective: req(input.objective, "objective"),
          inScope: arr(input.inScope, "inScope"),
          outOfScope: arr(input.outOfScope, "outOfScope"),
          testStrategy: arr(input.testStrategy, "testStrategy"),
          deliverables: arr(input.deliverables, "deliverables"),
          environment: Array.isArray(input.environment)
            ? input.environment.map((e) => ({ key: String(e?.key ?? ""), value: String(e?.value ?? "") }))
            : [],
          roles: Array.isArray(input.roles)
            ? input.roles.map((r) => ({ role: String(r?.role ?? ""), name: String(r?.name ?? ""), responsibility: String(r?.responsibility ?? "") }))
            : [],
          schedule: Array.isArray(input.schedule)
            ? input.schedule.map((s) => ({ event: String(s?.event ?? ""), startDate: String(s?.startDate ?? ""), endDate: String(s?.endDate ?? "") }))
            : [],
          risks: Array.isArray(input.risks)
            ? input.risks.map((r) => ({ risk: String(r?.risk ?? ""), mitigation: String(r?.mitigation ?? "") }))
            : [],
          approval: Array.isArray(input.approval)
            ? input.approval.map((a) => ({ name: String(a?.name ?? ""), role: String(a?.role ?? ""), signature: String(a?.signature ?? "") }))
            : [],
        });
      }),
    }),
    test_run: tool({
      description:
        "Run Playwright tests and return the result (passed/failed plus errors)",
      inputSchema: z.object({
        file: z
          .string()
          .optional()
          .describe(
             "specific filename; leave empty to run all tests"
          ),
      }),
      execute: wrap("test_run", async ({ file }: { file?: string }) => {
        const summary = await runSpec(file || undefined);
        await recordRun(file || null, summary);
        return summary;
      }),
    }),
    memory_save: tool({
      description:
        "Save durable facts to memory (user preferences, public demo site facts, important URLs). Never use this for passwords, API keys, or tokens",
      inputSchema: z.object({
        fact: z.string().describe("satu fakta singkat, satu baris"),
      }),
      execute: wrap("memory_save", async ({ fact }: { fact: string }) =>
        saveFact(fact)
      ),
    }),
    memory_forget: tool({
      description: "Remove an outdated memory fact by keyword",
      inputSchema: z.object({
        query: z.string().describe("keyword for the fact to remove"),
      }),
      execute: wrap("memory_forget", async ({ query }: { query: string }) =>
        forgetFact(query)
      ),
    }),
    test_plan: tool({
      description:
        "Save structured test cases (ID, Area, Type, Title, Preconditions, TestData, Steps, Expected, Priority, Severity) as .cases.json. Use before test_save",
      inputSchema: z.object({
        file: z
          .string()
          .describe("base file path, e.g. login-saucedemo.spec.ts or qabrains-ecommerce/login.spec.ts"),
        cases: z.array(TestCaseSchema).min(1).max(50),
      }),
      execute: wrap(
        "test_plan",
        async (input: {
          file?: string;
          cases?: {
            id?: string;
            area?: string;
            type?: string;
            title?: string;
            preconditions?: string;
            testData?: string;
            steps?: string[];
            expected?: string;
            priority?: "High" | "Medium" | "Low";
            severity?: "High" | "Medium" | "Low";
          }[];
        }) => {
          if (!input.file) throw new Error("file is required");
          const cases = (input.cases ?? []).map((c) => ({
            id: String(c.id ?? ""),
            area: String(c.area ?? ""),
            type: String(c.type ?? "Positive"),
            title: String(c.title ?? ""),
            preconditions: String(c.preconditions ?? ""),
            testData: String(c.testData ?? ""),
            steps: Array.isArray(c.steps) ? c.steps.map(String) : [],
            expected: String(c.expected ?? ""),
            priority: (["High", "Medium", "Low"].includes(c.priority as string) ? c.priority : "Medium") as "High" | "Medium" | "Low",
            severity: (["High", "Medium", "Low"].includes(c.severity as string) ? c.severity : "Medium") as "High" | "Medium" | "Low",
          }));
          if (!cases.length) throw new Error("cases cannot be empty");
          return mergeCases(input.file, cases);
        }
      ),
    }),
    test_list: tool({
      description:
        "List saved spec files (.spec.ts) in tests/",
      inputSchema: z.object({}),
      execute: wrap("test_list", async () => listSpecs()),
    }),
    test_record: tool({
      description:
        "Record manual test execution results (PASS, FAIL, BLOCKED, SKIPPED plus actual result) for saved case ids. Use after guiding the user through manual testing.",
      inputSchema: z.object({
        file: z
          .string()
          .describe("base file path, e.g. login-saucedemo.spec.ts or qabrains-ecommerce/login.spec.ts"),
        results: z.array(z.object({
          id: z.string().describe("case id, e.g. TC-001"),
          status: z.enum(["PASS", "FAIL", "BLOCKED", "SKIPPED"]),
          actual: z.string().optional().default(""),
        })).min(1).max(50),
      }),
      execute: wrap(
        "test_record",
        async (input: {
          file?: string;
          results?: { id?: string; status?: string; actual?: string }[];
        }) => {
          if (!input.file) throw new Error("file is required");
          const results = (input.results ?? []).map((r) => ({
            id: r.id ?? "",
            status: r.status ?? "",
            actual: r.actual ?? "",
          }));
          if (!results.length) throw new Error("results cannot be empty");
          return saveCaseResults(input.file, results);
        }
      ),
    }),
  };
}
