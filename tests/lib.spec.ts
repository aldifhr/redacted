import { test, expect } from "@playwright/test";
import { sanitizeFile, casesFile, saveCases, mergeCases, readCases, saveCaseResults, readCasesWithResults, deleteSpec, deleteCases } from "../src/lib/specs";
import { parseExplorationScope } from "../src/lib/exploration";
import { saveFact } from "../src/lib/memory";
import { assertPublicTarget } from "../src/lib/ssrf";
import { isReadOnlyCommand } from "../src/lib/browser";
import { getBrowserTools } from "../src/lib/agent";
import { rateLimit, tryEnter, leave } from "../src/lib/rate-limit";
import { requireAuth } from "../src/lib/auth";
import {
  deleteKey,
  fingerprintOf,
  getKey,
  hasKey,
  listKeys,
  resolveKey,
  saveKey,
  verifyKey,
} from "../src/lib/key-vault";
import { VAULT_MARKER } from "../src/lib/providers";
// Static, not `await import()`: Playwright transpiles what the test file
// imports statically, while a dynamic import of a .ts path falls through to
// Node's own loader — which cannot parse TypeScript on the CI runner (Node 20).
import { rowsToCases, suggestFileName } from "../src/lib/case-import";
import { loadExcelJs, parseCsv, readSpreadsheet } from "../src/lib/spreadsheet";
import { areaForUrl, looksLikeErrorPage, urlMatchesArea } from "../src/lib/report";
import { estimateCost, fmtTokens } from "../src/lib/cost";
import {
  clearRunTokens,
  estimateTokens,
  getRunTokenStats,
  recordBrowserAction,
  recordToolResult,
  recordTokenUsage,
  usageSnapshot,
} from "../src/lib/token-meter";
import { readRunLog, startRunLog, logRunEvent, finishRunLog } from "../src/lib/run-log";
import {
  appendEvidence,
  clearEvidence,
  countEvidence,
  evidenceRef,
  getEvidence,
  readEvidence,
} from "../src/lib/evidence-store";
import {
  buildExplorationState,
  buildSummaryContext,
  buildSystemContext,
  buildTaskContext,
  buildWorkingContext,
  composeExecutionPrompt,
  composeRoundMessages,
  renderEvidenceRefs,
  renderSummary,
} from "../src/lib/context";
import { withSpan } from "../src/lib/telemetry";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure unit tests for agent lib helpers (no browser, no file writes:
// every assertion below either validates input or expects a throw
// before any disk mutation happens).

test("sanitizeFile accepts plain names and appends the suffix", () => {
  expect(sanitizeFile("login-saucedemo")).toBe("login-saucedemo.spec.ts");
  expect(sanitizeFile("login-saucedemo.spec.ts")).toBe("login-saucedemo.spec.ts");
});

test("sanitizeFile neutralizes traversal via basename, rejects bad extensions", () => {
  // basename() strips directories, so traversal attempts collapse to a safe name
  expect(sanitizeFile("../evil")).toBe("evil.spec.ts");
  expect(sanitizeFile("a/b.spec.ts")).toBe("b.spec.ts");
  expect(() => sanitizeFile("spec.js")).toThrow();
  expect(() => sanitizeFile("")).toThrow();
});

test("casesFile maps a spec name to its .cases.json artifact", () => {
  expect(casesFile("login-saucedemo.spec.ts")).toBe("login-saucedemo.cases.json");
  expect(casesFile("login-saucedemo")).toBe("login-saucedemo.cases.json");
});

test("exploration scope extracts areas, priority, and continuation", () => {
  expect(parseExplorationScope("Continue https://example.com login and checkout, critical, max 8 browser actions")).toEqual({
    site: "https://example.com",
    areas: ["login", "checkout"],
    priority: "critical",
    maxActions: 8,
    continue: true,
  });
});

test("exploration scope does not treat a handoff mention as re-entry", () => {
  expect(parseExplorationScope("Explore login and report the next area for continue").continue).toBe(false);
});

test("incremental case merge replaces duplicate ids and preserves prior areas", async () => {
  const file = "tmp-merge.spec.ts";
  await saveCases(file, [
    { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page"], expected: "dashboard", priority: "High", severity: "High" },
  ]);
  try {
    await mergeCases(file, [
      { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page", "submit form"], expected: "dashboard", priority: "High", severity: "High" },
      { id: "TC-002", area: "Checkout", type: "Positive", title: "pay order", preconditions: "", testData: "", steps: ["open checkout"], expected: "confirmation", priority: "High", severity: "High" },
    ]);
    const cases = await readCases(file);
    expect(cases).toHaveLength(2);
    expect(cases.find((item) => item.id === "TC-001")?.steps).toEqual(["open page", "submit form"]);
    expect(cases.find((item) => item.id === "TC-002")?.area).toBe("Checkout");
  } finally {
    await deleteSpec(file).catch(() => null);
    await deleteCases(file);
  }
});

test("saveFact rejects secrets before touching disk", () => {
  expect(() => saveFact("api-key: sk-abcdefgh12345678")).toThrow();
  expect(() => saveFact("db password: supersecretvalue123")).toThrow();
});

test("ssrf guard blocks loopback, private, and metadata targets", async () => {
  await expect(assertPublicTarget("http://localhost:3000")).rejects.toThrow(/loopback/i);
  await expect(assertPublicTarget("http://127.0.0.1/")).rejects.toThrow(/loopback|private/i);
  await expect(assertPublicTarget("http://169.254.169.254/")).rejects.toThrow(/metadata|private/i);
  await expect(assertPublicTarget("http://[::1]/")).rejects.toThrow(/loopback|private/i);
});

test("ssrf guard allows loopback only with explicit opt-in", async () => {
  const url = await assertPublicTarget("http://localhost:11434", { allowLocal: true });
  expect(url.hostname).toBe("localhost");
  // metadata stays blocked even with opt-in
  await expect(assertPublicTarget("http://169.254.169.254/", { allowLocal: true })).rejects.toThrow();
});

test("isReadOnlyCommand separates readers from executors", () => {
  expect(isReadOnlyCommand("ls tests")).toBe(true);
  expect(isReadOnlyCommand("cat package.json")).toBe(true);
  expect(isReadOnlyCommand("grep -r foo src")).toBe(true);
  expect(isReadOnlyCommand("node script.js")).toBe(false);
  expect(isReadOnlyCommand("npm test")).toBe(false);
  expect(isReadOnlyCommand("npx playwright test")).toBe(false);
  expect(isReadOnlyCommand("ls; rm -rf /")).toBe(false);
  expect(isReadOnlyCommand("")).toBe(false);
});

test("bash without approval channel denies executors, allows readers", async () => {
  const tools = getBrowserTools();
  const bash = tools.browser_bash as unknown as { execute: (input: unknown) => Promise<unknown> };
  await expect(bash.execute({ command: "npx something-evil" })).rejects.toThrow(/denied/i);
  // Allowlisted but not read-only: still denied when no human is in the loop.
  await expect(bash.execute({ command: "node -e 'console.log(1)'" })).rejects.toThrow(/denied/i);
  // `echo` is a cmd.exe builtin with no spawnable exe on Windows, so the
  // read-only happy path can only be exercised where a real binary exists.
  if (process.platform !== "win32") {
    const out = (await bash.execute({ command: "echo hi" })) as { stdout: string };
    expect(out.stdout.trim()).toBe("hi");
  }
});

test("rate limiter allows then rejects over the limit", () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  expect(rateLimit(key, 2, 60_000)).toBeNull();
  expect(rateLimit(key, 2, 60_000)).toBeNull();
  const rejected = rateLimit(key, 2, 60_000);
  expect(rejected).not.toBeNull();
  expect(rejected?.status).toBe(429);
});

test("concurrent slots guard expensive endpoints", () => {
  const slot = `test-slot-${Date.now()}`;
  expect(tryEnter(slot, 1)).toBe(true);
  expect(tryEnter(slot, 1)).toBe(false);
  leave(slot);
  expect(tryEnter(slot, 1)).toBe(true);
  leave(slot);
});

test("manual results round-trip with validation", async () => {  const file = "tmp-manual.spec.ts";
  await saveCases(file, [
    { id: "TC-001", area: "Login", type: "Positive", title: "valid login", preconditions: "", testData: "", steps: ["open page"], expected: "dashboard", priority: "High", severity: "High" },
  ]);
  try {
    await expect(saveCaseResults(file, [{ id: "TC-999", status: "PASS" }])).rejects.toThrow(/unknown case id/i);
    await expect(saveCaseResults(file, [{ id: "TC-001", status: "MAYBE" }])).rejects.toThrow(/invalid status/i);
    const saved = await saveCaseResults(file, [{ id: "TC-001", status: "pass", actual: "dashboard shown" }]);
    expect(saved.summary.PASS).toBe(1);
    const merged = await readCasesWithResults(file);
    expect(merged[0].result.status).toBe("PASS");
    expect(merged[0].result.actual).toBe("dashboard shown");
  } finally {
    await deleteSpec(file).catch(() => null);
    await deleteCases(file);
  }
});

test("auth is open without token, enforced with token", () => {
  expect(requireAuth(new Request("http://x/"))).toBeNull();
  process.env.APP_TOKEN = "secret-token";
  try {
    expect(requireAuth(new Request("http://x/"))?.status).toBe(401);
    expect(
      requireAuth(new Request("http://x/", { headers: { Authorization: "Bearer secret-token" } }))
    ).toBeNull();
    expect(
      requireAuth(new Request("http://x/", { headers: { Authorization: "Bearer wrong" } }))?.status
    ).toBe(401);
  } finally {
    delete process.env.APP_TOKEN;
  }
});

test("rowsToCases maps headers, splits steps, dedupes ids", async () => {
  const headers = ["ID", "Area", "Type", "Title", "Test Data", "Test Step", "Expected Result", "Priority"];
  const out = rowsToCases(headers, [
    ["LGN001", "Login", "Positive", "valid login", "standard_user", "1. Input user 2. Input pass 3. Click login", "dashboard", "High"],
    ["LGN001", "Login", "Negative", "dup id", "", "1. Do x", "error", ""],
    ["", "", "", "", "", "", "", ""],
  ]);
  expect(out).toHaveLength(2);
  expect(out[0].steps).toEqual(["Input user", "Input pass", "Click login"]);
  expect(out[0].priority).toBe("High");
  expect(out[1].id).not.toBe("LGN001");
  expect(out[1].priority).toBe("Medium");
  const fb = rowsToCases(["Title", "Expected Result"], [["t", "e"]], { areaFallback: "Cart", idPrefix: "CART" });
  expect(fb[0].id).toBe("CART-001");
  expect(fb[0].area).toBe("Cart");
  expect(suggestFileName("TestCase_SauceDemo.xlsx")).toBe("TestCase_SauceDemo.spec.ts");
  await expect(async () => rowsToCases(["Foo", "Bar"], [["a", "b"]])).rejects.toThrow();
});

test("parseCsv handles quotes, embedded commas/newlines, CRLF and BOM", () => {
  expect(parseCsv('id,title\r\n1,"a, b"\r\n2,"line1\nline2"\r\n3,"say ""hi"""\r\n')).toEqual([
    ["id", "title"],
    ["1", "a, b"],
    ["2", "line1\nline2"],
    ["3", 'say "hi"'],
  ]);
  expect(parseCsv("\uFEFFid,title\n1,x")).toEqual([
    ["id", "title"],
    ["1", "x"],
  ]);
  expect(parseCsv("")).toEqual([]);
});

test("readSpreadsheet reads csv, xlsx and rejects legacy .xls", async () => {
  const asFile = (bytes: Uint8Array, name: string) =>
    new File([bytes as unknown as BlobPart], name);

  const csv = await readSpreadsheet(
    asFile(new TextEncoder().encode("ID,Title\nTC-1,login\n"), "cases.csv")
  );
  expect(csv).toHaveLength(1);
  expect(csv[0].name).toBe("CSV");
  expect(csv[0].rows[0]).toEqual(["ID", "Title"]);
  expect(csv[0].rows[1]).toEqual(["TC-1", "login"]);

  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Login");
  ws.addRow(["ID", "Title", "Steps"]);
  ws.addRow(["TC-001", "valid login", "1. Open page\n2. Click login"]);
  ws.addRow([42, true, null]);
  const xlsx = await readSpreadsheet(asFile(new Uint8Array(await wb.xlsx.writeBuffer()), "cases.xlsx"));
  expect(xlsx).toHaveLength(1);
  expect(xlsx[0].name).toBe("Login");
  expect(xlsx[0].rows[0]).toEqual(["ID", "Title", "Steps"]);
  expect(xlsx[0].rows[1]).toEqual(["TC-001", "valid login", "1. Open page\n2. Click login"]);
  expect(xlsx[0].rows[2]).toEqual(["42", "true", ""]);

  // OLE2 magic — the format xlsx@0.18.5 accepted and exceljs deliberately does not.
  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  await expect(readSpreadsheet(asFile(ole2, "legacy.xls"))).rejects.toThrow(/legacy \.xls/);
});

test("readSpreadsheet import path produces cases end-to-end", async () => {
  const csv = "ID,Area,Title,Steps,Expected Result\nLGN-1,Login,valid login,1. Open page 2. Click login,dashboard\n";
  const sheets = await readSpreadsheet(
    new File([new TextEncoder().encode(csv)] as unknown as BlobPart[], "cases.csv")
  );
  const [head, ...rows] = sheets[0].rows;
  const cases = rowsToCases(head, rows, { areaFallback: "Sheet", idPrefix: "SH" });
  expect(cases).toHaveLength(1);
  expect(cases[0].id).toBe("LGN-1");
  expect(cases[0].steps).toEqual(["Open page", "Click login"]);
});

test("area mapping never treats every homepage as login or /cartoon as cart", () => {
  expect(areaForUrl("https://shop.example/")).toBeNull();
  expect(areaForUrl("https://shop.example/cartoon")).toBeNull();
  expect(areaForUrl("https://shop.example/cart")).toBe("cart");
  expect(urlMatchesArea("https://shop.example/", "login")).toBe(true);
  expect(urlMatchesArea("https://shop.example/", "checkout")).toBe(false);
  expect(urlMatchesArea("https://shop.example/cartoon", "cart")).toBe(false);
});

test("error-page detection ignores ordinary 'not found' copy", () => {
  expect(looksLikeErrorPage("No products found in this category")).toBe(false);
  expect(looksLikeErrorPage("404 page not found")).toBe(true);
  expect(looksLikeErrorPage("This site can't be reached")).toBe(true);
});

test("ssrf guard blocks the extended private/reserved ranges", async () => {
  await expect(assertPublicTarget("http://100.64.0.1/")).rejects.toThrow(/private/i);
  await expect(assertPublicTarget("http://192.0.2.10/")).rejects.toThrow(/private/i);
  await expect(assertPublicTarget("http://198.18.0.1/")).rejects.toThrow(/private/i);
  await expect(assertPublicTarget("http://203.0.113.5/")).rejects.toThrow(/private/i);
  await expect(assertPublicTarget("http://240.0.0.1/")).rejects.toThrow(/private/i);
});

test("ssrf guard unwraps hex IPv4-mapped IPv6", async () => {
  await expect(assertPublicTarget("http://[::ffff:7f00:1]/")).rejects.toThrow(/private/i);
});

test("cost meter prices known models and formats token counts", () => {
  expect(estimateCost("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 6);
  expect(estimateCost("claude-sonnet-4-5", 0, 1_000_000)).toBeCloseTo(15, 6);
  expect(estimateCost("unknown-model", 1000, 1000)).toBeNull();
  expect(fmtTokens(999)).toBe("999");
  expect(fmtTokens(12_345)).toBe("12.3k");
  expect(fmtTokens(2_500_000)).toBe("2.5M");
});

test("run log persists events and a terminal status", async () => {
  const runId = `test-unit-${Date.now()}`;
  try {
    await startRunLog(runId, "session-1");
    await logRunEvent(runId, "status", { label: "Working" });
    await logRunEvent(runId, "done", { text: "finished" });
    await finishRunLog(runId, "done");
    const { meta, events } = await readRunLog(runId);
    expect(meta?.sessionId).toBe("session-1");
    expect(meta?.status).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["status", "done"]);
  } finally {
    await fs.unlink(join(process.cwd(), ".runs", `${runId}.jsonl`)).catch(() => {});
    await fs.unlink(join(process.cwd(), ".runs", `${runId}.meta.json`)).catch(() => {});
  }
});

// Vault isolasi lewat KEY_VAULT_DIR (temp dir) supaya tidak menyentuh
// logs/keys.vault.json asli di mesin dev.
async function withVaultDir(fn: () => Promise<void> | void) {
  const dir = await fs.mkdtemp(join(tmpdir(), "key-vault-"));
  const prev = process.env.KEY_VAULT_DIR;
  process.env.KEY_VAULT_DIR = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.KEY_VAULT_DIR;
    else process.env.KEY_VAULT_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("key vault encrypts at rest, verifies by hash, and never writes the raw key", async () => {
  await withVaultDir(async () => {
    expect(hasKey("openai")).toBe(false);
    expect(getKey("openai")).toBeNull();

    const fingerprint = saveKey("openai", "sk-test-1234567890");
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).toBe(fingerprintOf("sk-test-1234567890"));
    expect(hasKey("openai")).toBe(true);
    expect(getKey("openai")).toBe("sk-test-1234567890");

    // file di disk memuat ciphertext + hash, tidak pernah key mentah
    const raw = await fs.readFile(join(process.env.KEY_VAULT_DIR!, "keys.vault.json"), "utf8");
    expect(raw).not.toContain("sk-test-1234567890");
    expect(raw).toContain(fingerprint);

    expect(verifyKey("openai", "sk-test-1234567890")).toBe(true);
    expect(verifyKey("openai", "sk-wrong-1234567890")).toBe(false);

    expect(listKeys()).toEqual([
      { provider: "openai", fingerprint, updatedAt: expect.any(Number) },
    ]);

    expect(deleteKey("openai")).toBe(true);
    expect(deleteKey("openai")).toBe(false);
    expect(getKey("openai")).toBeNull();
    expect(listKeys()).toEqual([]);
  });
});

test("resolveKey prefers the presented key, falls back to the vault, then throws", async () => {
  await withVaultDir(() => {
    // tanpa vault: key yang dikirim menang
    expect(resolveKey("openai", "sk-presented-123456")).toBe("sk-presented-123456");
    // tanpa vault dan tanpa key: error yang mengarahkan ke /settings
    expect(() => resolveKey("openai", "")).toThrow(/API key is required/);
    expect(() => resolveKey("anthropic", VAULT_MARKER)).toThrow(/API key is required/);

    saveKey("openai", "sk-vault-1234567890");
    // marker/empty → pakai vault
    expect(resolveKey("openai", "")).toBe("sk-vault-1234567890");
    expect(resolveKey("openai", VAULT_MARKER)).toBe("sk-vault-1234567890");
    // key yang dikirim tetap menang atas vault
    expect(resolveKey("openai", "sk-presented-123456")).toBe("sk-presented-123456");
  });
});

// ── token-meter: centralized LLM usage accounting ──

test("token meter records provider usage exactly and never flags it estimated", () => {
  const runId = "meter-exact";
  clearRunTokens(runId);
  recordTokenUsage({
    runId,
    phase: "EXPLORATION",
    round: 0,
    agent: "main",
    model: "gpt-4o",
    provider: "openai",
    usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000 },
    durationMs: 500,
  });
  const stats = getRunTokenStats(runId)!;
  expect(stats.inputTokens).toBe(1200);
  expect(stats.outputTokens).toBe(300);
  expect(stats.totalTokens).toBe(1500);
  expect(stats.cachedInputTokens).toBe(1000);
  expect(stats.estimatedTokens).toBe(0);
  expect(stats.requests).toBe(1);
  expect(stats.rounds).toBe(1);
  expect(stats.byPhase.EXPLORATION.totalTokens).toBe(1500);
  expect(stats.largestRequest).toEqual({ totalTokens: 1500, phase: "EXPLORATION", round: 0 });
});

test("token meter labels char estimates as estimated, including partial usage", () => {
  const runId = "meter-estimated";
  clearRunTokens(runId);
  // no provider usage at all → both sides estimated from chars
  recordTokenUsage({
    runId,
    phase: "REPORTING",
    round: 3,
    agent: "main",
    model: "m",
    provider: "p",
    requestChars: 40000,
    responseChars: 800,
    durationMs: 100,
  });
  // partial usage: input exact, output missing → still flagged estimated
  recordTokenUsage({
    runId,
    phase: "REPORTING",
    round: 4,
    agent: "main",
    model: "m",
    provider: "p",
    usage: { inputTokens: 100 },
    responseChars: 800,
    durationMs: 100,
  });
  const stats = getRunTokenStats(runId)!;
  expect(stats.inputTokens).toBe(10100); // 10000 estimated + 100 exact
  expect(stats.outputTokens).toBe(400); // 200 + 200, both estimated
  expect(stats.estimatedTokens).toBe(10400); // everything except the exact 100
  expect(stats.totalTokens).toBe(10500);
  expect(stats.byPhase.REPORTING.requests).toBe(2);
});

test("token meter accumulates across requests without double counting", () => {
  const runId = "meter-accumulate";
  clearRunTokens(runId);
  for (let i = 0; i < 5; i += 1) {
    recordTokenUsage({
      runId,
      phase: "EXPLORATION",
      round: i,
      agent: "main",
      model: "m",
      provider: "p",
      usage: { inputTokens: 100, outputTokens: 10 },
      durationMs: 1,
    });
  }
  recordTokenUsage({
    runId,
    phase: "EXPLORATION",
    round: 0,
    agent: "sub",
    model: "m",
    provider: "p",
    usage: { inputTokens: 50, outputTokens: 5 },
    durationMs: 1,
  });
  const stats = getRunTokenStats(runId)!;
  expect(stats.requests).toBe(6);
  expect(stats.totalTokens).toBe(5 * 110 + 55);
  expect(stats.rounds).toBe(5); // sub-agent requests are not main model rounds
  expect(stats.byPhase.EXPLORATION.requests).toBe(6);
  expect(stats.largestRequest?.totalTokens).toBe(110);
});

test("token meter tracks the largest tool result and browser actions", () => {
  const runId = "meter-toolresult";
  clearRunTokens(runId);
  recordToolResult(runId, "browser_snapshot", { elements: "x".repeat(12000) });
  recordToolResult(runId, "browser_click", { ok: true });
  recordBrowserAction(runId);
  recordBrowserAction(runId);
  const stats = getRunTokenStats(runId)!;
  expect(stats.largestToolResult?.tool).toBe("browser_snapshot");
  expect(stats.largestToolResult?.chars).toBeGreaterThan(12000);
  expect(stats.browserActions).toBe(2);
});

test("token meter snapshot stays UI-compatible and unknown runs read as zero", () => {
  expect(usageSnapshot(null)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  expect(usageSnapshot(getRunTokenStats("meter-missing"))).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  expect(estimateTokens(40000)).toBe(10000);
  expect(estimateTokens(0)).toBe(0);
  expect(estimateTokens(-5)).toBe(0);
  clearRunTokens("meter-missing");
});

// ── evidence-store: full-fidelity evidence, independent of LLM context ──

// Isolasi lewat EVIDENCE_DIR (temp dir) supaya tidak menyentuh .runs asli.
async function withEvidenceDir(fn: () => Promise<void> | void) {
  const dir = await fs.mkdtemp(join(tmpdir(), "evidence-"));
  const prev = process.env.EVIDENCE_DIR;
  process.env.EVIDENCE_DIR = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.EVIDENCE_DIR;
    else process.env.EVIDENCE_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("evidence store keeps full payloads, assigns stable ordered ids, filters by kind", async () => {
  await withEvidenceDir(async () => {
    const runId = "evidence-run-1";
    const big = "x".repeat(50_000);
    const snap = await appendEvidence(runId, {
      kind: "snapshot",
      tool: "browser_snapshot",
      url: "https://www.saucedemo.com/inventory.html",
      data: { url: "https://www.saucedemo.com/inventory.html", elements: big },
    });
    expect(snap.id).toBe("ev_1");
    expect(snap.chars).toBeGreaterThan(50_000); // full payload, never truncated

    const assert1 = await appendEvidence(runId, {
      kind: "assert",
      tool: "test_assert",
      url: "https://www.saucedemo.com/cart.html",
      selector: ".shopping_cart_badge",
      pass: true,
      data: { pass: true, actual: "badge shows 1" },
    });
    expect(assert1.id).toBe("ev_2");

    const all = await readEvidence(runId);
    expect(all.map((r) => r.id)).toEqual(["ev_1", "ev_2"]);
    expect(await countEvidence(runId)).toBe(2);

    const snaps = await readEvidence(runId, { kind: "snapshot" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe("ev_1");
    const byTool = await readEvidence(runId, { tool: "test_assert" });
    expect(byTool[0].pass).toBe(true);

    const fetched = await getEvidence(runId, "ev_1");
    expect(fetched?.chars).toBe(snap.chars);
    expect(await getEvidence(runId, "ev_missing")).toBeNull();

    await clearEvidence(runId);
    expect(await countEvidence(runId)).toBe(0);
  });
});

test("evidence refs are compact one-liners that never carry the payload", async () => {
  await withEvidenceDir(async () => {
    const runId = "evidence-run-2";
    const rec = await appendEvidence(runId, {
      kind: "snapshot",
      tool: "browser_snapshot",
      url: "https://www.saucedemo.com/inventory.html",
      data: { elements: "SECRET-PAYEYOAD".repeat(1000) },
    });
    const ref = evidenceRef(rec);
    expect(ref.startsWith("ev_1 snapshot /inventory.html")).toBe(true);
    expect(ref).toContain("chars");
    expect(ref.length).toBeLessThan(200);
    expect(ref).not.toContain("SECRET-PAYEYOAD");
    expect(renderEvidenceRefs([rec])).toBe(ref);
    await clearEvidence(runId);
  });
});

// ── context layers: separation, bounded working window, compact summary ──

test("context task layer derives objective, plan, criteria, and status", () => {
  const task = buildTaskContext({
    userRequest: "Open saucedemo, log in, explore all testable areas",
    areas: ["login", "products", "cart", "checkout"],
    completedAreas: ["login"],
  });
  expect(task.userRequest).toContain("saucedemo");
  expect(task.objective).toContain("login, products, cart, checkout");
  expect(task.plan).toEqual(["login", "products", "cart", "checkout"]);
  expect(task.acceptanceCriteria).toHaveLength(4);
  expect(task.status).toBe("1/4 areas verified");
});

test("context exploration state marks the first pending area current", () => {
  const state = buildExplorationState({
    currentUrl: "https://www.saucedemo.com/cart.html",
    areas: ["login", "products", "cart", "checkout"],
    completedAreas: ["login", "products"],
    lastAction: "browser_click",
    browserActions: 12,
  });
  expect(state.currentArea).toBe("cart");
  expect(state.pendingAreas).toEqual(["cart", "checkout"]);
  expect(state.completedAreas).toEqual(["login", "products"]);
  expect(state.failedAreas).toEqual([]);
  expect(state.browserActions).toBe(12);
});

test("context working layer bounds the recent-turn window", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` }));
  const bounded = buildWorkingContext({ recentTurns: turns, currentObservation: "obs", maxTurns: 3 });
  expect(bounded.recentTurns).toHaveLength(3);
  expect(bounded.recentTurns[0].content).toBe("turn 7");
  expect(bounded.turnCount).toBe(10); // full count preserved for accounting
  const unbounded = buildWorkingContext({ recentTurns: turns, currentObservation: "obs" });
  expect(unbounded.recentTurns).toHaveLength(10);
});

test("context summary renders evidence ids only, never raw payloads", () => {
  const summary = buildSummaryContext({
    task: "Explore SauceDemo",
    currentUrl: "/inventory.html",
    completedAreas: [{ area: "login", status: "VERIFIED", evidenceIds: ["ev_1", "ev_2"] }],
    pendingAreas: ["products", "cart"],
    failedAttempts: ["sort dropdown did not reorder"],
    nextTask: "Explore product sorting",
  });
  const rendered = renderSummary(summary);
  expect(rendered).toContain("ev_1");
  expect(rendered).toContain("ev_2");
  expect(rendered).toContain("Explore product sorting");
  expect(rendered).toContain("sort dropdown did not reorder"); // failures survive
  expect(rendered).not.toContain("<<<BEGIN UNTRUSTED"); // never raw page payloads
});

test("context summary preserves verified vs pending distinction", () => {
  const summary = buildSummaryContext({
    task: "Explore SauceDemo",
    completedAreas: [{ area: "login", status: "VERIFIED", evidenceIds: ["ev_1"] }],
    pendingAreas: ["products"],
  });
  const parsed = JSON.parse(renderSummary(summary));
  expect(parsed.completedAreas[0].status).toBe("VERIFIED");
  expect(parsed.pendingAreas).toEqual(["products"]);
  expect(parsed.lastCompaction).toBeTruthy();
});

test("composeExecutionPrompt keeps instructions, scope, rules, and budget sentence", () => {
  const scope = {
    site: "https://www.saucedemo.com",
    areas: ["login", "cart"],
    priority: "medium" as const,
    maxActions: Number.POSITIVE_INFINITY,
    continue: false,
  };
  const prompt = composeExecutionPrompt({
    systemPrompt: "SYSTEM-INSTRUCTIONS",
    scope,
    completedAreas: [],
    currentArea: "login",
    nextArea: "cart",
  });
  expect(prompt).toContain("SYSTEM-INSTRUCTIONS");
  expect(prompt).toContain("# Current exploration scope");
  expect(prompt).toContain('"areas"');
  expect(prompt).toContain("Execute at most one tool call per model round");
  expect(prompt).toContain("no browser-action budget");

  const bounded = composeExecutionPrompt({
    systemPrompt: "S",
    scope: { ...scope, maxActions: 8 },
    completedAreas: ["login"],
    currentArea: "cart",
    nextArea: "",
  });
  expect(bounded).toContain("Use at most 8 browser actions");
});

test("composeRoundMessages puts the task/state opening turn first", () => {
  const task = buildTaskContext({ userRequest: "explore", areas: ["login"], completedAreas: [] });
  const state = buildExplorationState({
    currentUrl: "https://x.test/",
    areas: ["login"],
    completedAreas: [],
    lastAction: "browser_navigate",
    browserActions: 1,
  });
  const working = buildWorkingContext({
    recentTurns: [{ role: "assistant", content: "prior" }],
    currentObservation: "obs",
  });
  const messages = composeRoundMessages({ task, state, working });
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("user");
  const opening = String(messages[0].content);
  expect(opening).toContain("Task: explore");
  expect(opening).toContain("url=https://x.test/");
  expect(opening).toContain("browserActions=1");
  expect(messages[1].content).toBe("prior");
});

test("buildSystemContext totals instruction and rule sizes", () => {
  const sys = buildSystemContext("abc", "de");
  expect(sys.chars).toBe(5);
  expect(sys.instructions).toBe("abc");
  expect(sys.rules).toBe("de");
});

test("withSpan passes results through and rethrows without swallowing", async () => {
  // tanpa SDK terdaftar tracer no-op, tapi kontrak helper tetap harus jalan
  await expect(withSpan("test.ok", async () => 42)).resolves.toBe(42);
  await expect(
    withSpan("test.fail", async () => {
      throw new Error("boom");
    })
  ).rejects.toThrow("boom");
});
